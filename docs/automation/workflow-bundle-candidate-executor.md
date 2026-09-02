# WorkflowBundle candidate executor 운영 계약

## 목적과 범위

`workflow-bundle-candidate-executor-v1`은 중앙 WorkflowBundle v5 `CANDIDATE`를 Happy Farm과 Lizard Tycoon의 static check·Android build-only에서 검증하기 위한 전용 deterministic worker다. 일반 Codex/Claude queue나 개인 PAT를 사용하지 않는다. 마켓 업로드, 심사, 공개 배포, role·permission·key 변경은 이 계약에 없다.

제어 경계는 다음과 같다.

- `POST /api/control-plane/workflow-bundle-candidate-executions`: `PLAN` 또는 `ENQUEUE`. exact registry record, MANAGED PRODUCT_APP registration, default-branch source, ACTIVE signed ConfigRevision, GitHub App installation observation을 결합한다.
- `GET /api/control-plane/workflow-bundle-candidate-executions?runId=...`: 공개 run·step 결과와 readback 상태만 반환한다.
- `POST /api/internal/workflow-bundle-candidate-executor`: 후보 executor 전용 bearer와 30초 Ed25519 route/body attestation을 모두 소비한다. generic adapter의 principal, SPIFFE identity, bearer, attestation key를 재사용하지 않으며 secret이나 installation token을 반환하지 않는다.
- `k8s/workflow-bundle-candidate-executor.yaml`: immutable Backoffice image로 실행하는 `suspend: true` CronJob이다.

## 불변 task와 mutation

task는 candidate registry record ID/SHA/payload/artifact, ACTIVE config revision/snapshot digest, repository ID/full name/default source, GitHub installation ID, branch, PR marker, 생성 caller 두 파일과 각 digest를 하나의 `planDigest`로 고정한다. branch와 PR marker에는 bundle/source/config/mutation을 결합한 전체 plan identity digest를 넣어 같은 plan replay는 같은 ref를 쓰고 새 source 또는 config 검증은 이전 closed ref와 충돌하지 않는다. 수정 가능한 파일은 다음 둘뿐이다.

- `.github/workflows/org-contract.yml`
- `.github/workflows/android-build-only.yml`

worker는 repository 하나에 제한된 GitHub App installation token을 callback 내부에서만 사용하고 즉시 폐기한다. token permission은 `contents:write`, `workflows:write`, `pull_requests:write`, `issues:read`, `metadata:read` exact set이다. `CREATE_COMMIT`, `CREATE_REF`, `CREATE_PR` 각각은 기존 `AgentActionGrant`와 durable step CAS/readback ledger를 통과해야 한다.

각 write 직전 다음을 다시 읽는다.

- 현재 default branch와 exact source SHA
- issue가 있으면 OPEN + `autopilot`, 그리고 `blocked`, `no-autopilot`, `approval:*` 부재
- repository의 open autonomous Ready PR 0개
- exact CANDIDATE record와 ACTIVE signed ConfigRevision
- GitHub App `callerBootstrapPullRequest=GRANTED`

provider 응답 유실이나 process 종료 뒤에는 같은 write를 반복하지 않는다. 기존 execution과 branch/commit/PR을 `READBACK_FIRST`로 확인한 뒤에만 미완료 step을 재개한다.
worker는 claim generation을 포함한 heartbeat를 60초 간격으로 보내며 session, lease, run generation이 모두 같을 때만 300초 lease를 연장한다.

## 활성화 gate

현재 manifest는 의도적으로 실행되지 않는다. 다음이 모두 확인된 뒤 별도 운영 변경으로만 활성화한다.

1. GitHub App installation observation에 `contents:write`, `workflows:write`, `pull_requests:write`와 `pull_request` event가 `GRANTED`로 보인다.
2. `backoffice.vzyx.xyz`와 `api.github.com`만 허용하는 CNI FQDN egress가 적용됐다.
3. 전용 projected secret의 공개 App ID, candidate adapter principal, SPIFFE service account, Ed25519 fingerprint가 canonical credential inventory와 일치하며 generic adapter secret과 겹치지 않는다. 키를 새로 만들거나 원문을 출력하지 않는다.
4. manifest를 exact image digest로 render하고 token scope/revoke, look-alike repo 거부, 세 단계 partial-resume를 검증한다. 실행기는 `CANDIDATE_REPOSITORIES` 허용 목록 밖 저장소를 `WORKFLOW_BUNDLE_CANDIDATE_REPOSITORY_NOT_ALLOWED`로 거부하므로 별도 fake private repository 대신 loopback 픽스처 `scripts/test-workflow-bundle-candidate-executor.ts`(claim/START/READBACK_FIRST/partial-resume/lease 폐기)와 `assertExactScope`·`finally` revoke 검증, 그리고 첫 시범 저장소 PR을 canary로 기록한다.
5. Backoffice의 `WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_DEPLOYED=true`와 CronJob `suspend=false`를 같은 승인 변경으로 반영한다.

어느 조건이라도 빠지면 `PLAN`은 공개 missing permission을 `BLOCKED`로 표시하고 `ENQUEUE/claim`은 fail-closed한다. 일반 `AGENT_TRUSTED_ADAPTER_DEPLOYED`나 generic READY_PR canary를 이 worker가 대신 열지 않는다.

## 활성화 기록

- 2026-09-02: happy-farm·lizard-tycoon build-only 시범을 위해 활성화한다. Backoffice `WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_DEPLOYED=true`, CronJob `suspend=false`, `backoffice-secrets`의 후보 adapter bearer/attestation 공개키 실행 복제본, `backoffice-workflow-bundle-v5-trust` ConfigMap(`k8s/workflow-bundle-v5-trust-configmap.yaml`, 승인 keyId `workflow-bundle-v5-20260902-145012ae1370`)을 같은 변경으로 반영한다. auth-broker의 `workflow-bundle-candidate-{backoffice,attestation,github}` Secret, `seori-auth-agent-public-bindings` ConfigMap, `registry-pull-cred` 복제본, egress proxy canary, CronJob render/apply는 trusted operator가 `docs/DEPLOY.md`의 "WorkflowBundle 후보 executor 활성화" 순서로 수행한다. 큐가 비어 있으면 첫 tick은 `no claim`으로 끝나야 한다.
