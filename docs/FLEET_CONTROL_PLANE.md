# Fleet Control Plane v1

이 문서는 기존 앱별 JSON consumer를 유지한 채 도입한 Fleet Control Plane의 운영 계약이다.
provider 실행 큐와 worker 경계는 구현되어 있지만 설치 manifest는 기본 `replicas: 0`이다. 아래 활성화
gate 전에는 provider 쓰기나 마켓 upload가 일어나지 않는다. 심사 제출, 공개 배포, credential 값
저장·조회 기능은 이 경계에 존재하지 않는다.

## 인증과 공통 헤더

- 제어면 API: `Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN`과
  `X-Seori-Principal: $CONTROL_PLANE_ADMIN_PRINCIPAL`
- Codex agent queue API: `Authorization: Bearer $AGENT_WORKER_CODEX_TOKEN`과
  `X-Seori-Principal: codex:seorilabs-generic-worker`
- Claude agent queue API: `Authorization: Bearer $AGENT_WORKER_CLAUDE_TOKEN`과
  `X-Seori-Principal: claude:seorilabs-generic-worker`
- 두 worker capability는 서로 다른 값이어야 한다. legacy `AGENT_WORKER_TOKEN`과
  agent queue의 `X-Admin-Token`은 인증에 사용하지 않으며, 새 capability가 없으면 fail-closed한다.
- 제어면 principal은 token과 1:1로 결합하며 임의 header 값이나 미설정 principal은 거부한다.
- 모든 mutation: 8자 이상의 `Idempotency-Key`
- Config activation과 resolved manifest: 전용 Secret `backoffice-control-plane-snapshot-signing`의 `CONTROL_PLANE_SNAPSHOT_SIGNING_KEY`
- agent claim: worker에 노출하지 않는 `AGENT_LEASE_SIGNING_KEY`

토큰 audience와 worker principal을 함께 결합하며, audit에는 principal, logical entity ID, digest와 공개 식별자만 남긴다.
payload·result에는 비밀번호, TOTP seed, cookie, API key, receipt 또는 개인 식별자를 넣지 않는다.

## API

| Method | Path | 계약 |
| --- | --- | --- |
| `POST` | `/api/control-plane/discovery-observations` | 정확한 40자리 source SHA의 탐지 결과, strict `workflowCaller`, build target projection 기록 |
| `POST` | `/api/control-plane/provider-observations` | provider readback과 공개 external binding 기록 |
| `POST` | `/api/control-plane/config-revisions` | immutable `DRAFT` revision 생성 |
| `GET/POST` | `/api/control-plane/desired-state-backfill` | ACTIVE 앱 전체의 분류·입력 필요 요약 조회 / exact discovery에서 확인된 market만 중앙 `DRAFT`로 멱등 backfill |
| `GET/POST` | `/api/control-plane/repository-classification-decisions` | `NEEDS_INPUT` 큐 조회 / generation과 decision revision CAS로 사람·승인된 AI의 append-only 분류 결정 기록 |
| `POST` | `/api/control-plane/config-revisions/activate` | `expectedActiveRevision` CAS로 `DRAFT → ACTIVE`, 이전 ACTIVE는 `SUPERSEDED` |
| `GET` | `/api/control-plane/apps/{repoId}/resolved-manifest?ref={sha}&market=&revision=` | exact SHA observation의 `workflowCaller`와 서명 검증된 config snapshot 조립 |
| `GET` | `/api/control-plane/apps/{repoId}/project-blueprint-plan?ref={sha}&revision=` | exact SHA와 ACTIVE revision의 GCP/Firebase/Workspace plan 및 readback 상태 계산. provider write 없음 |
| `POST` | `/api/control-plane/provider-executions` | exact repo/source/ACTIVE config/desired/public identity/credential generation에 결합된 readback, deterministic apply 또는 internal upload 실행을 durable queue에 등록 |
| `POST` | `/api/control-plane/release-candidates` | source SHA, ACTIVE config, market target, artifact checksum, WorkflowBundle SHA·digest, Platform version을 하나의 candidate로 고정 |
| `POST` | `/api/control-plane/release-gate-observations` | candidate에 결합된 독립 gate observation append |
| `GET` | `/api/control-plane/platform-releases` | 내부 producer가 검증·기록한 `FLEET_APPROVED` release 불변 원장을 조회 |
| `POST` | `/api/control-plane/platform-fleet/reconcile` | 현재 ACTIVE app 전체 cohort와 exact discovery/provider observation으로 repo별 plan을 한 번만 생성 |
| `GET` | `/api/control-plane/reauth-requests?repoId=` | 앱 범위의 공개 reauth gate와 대기 상태 조회 |
| `POST` | `/api/control-plane/reauth-requests` | 비밀값 없이 `HUMAN_REAUTH_REQUIRED` append |
| `POST` | `/api/internal/agents/claim` | 최대 5분 lease와 generation capability 발급 |
| `POST` | `/api/internal/agents/heartbeat` | 현재 generation lease만 연장 |
| `POST` | `/api/internal/agents/complete` | 현재 generation을 성공 종료 |
| `POST` | `/api/internal/agents/fail` | attempt 한도 내 재큐잉, 초과 시 dead-letter |
| `POST` | `/api/internal/agents/readback-required` | 외부 mutation 결과 불명을 기록하고 같은 run guard를 유지 |
| `POST` | `/api/internal/agents/readback` | 같은 run을 재claim한 새 generation lease로 `RESUME`, `COMPLETE`, `BLOCKED` 판정 |
| `POST` | `/api/control-plane/automation-definitions` | agent, cadence, 예산 상한, 승인 정책이 고정된 routine 생성 |
| `POST` | `/api/control-plane/automation-definitions/{id}/commands` | 즉시 실행, pause/resume, run cancel/dead-letter retry |
| `POST` | `/api/admin/automation/schedule` | webhook inbox, 누락 schedule, 만료 lease, terminal PR guard 조정 |
| `POST` | `/api/admin/automation/project-projections` | Fleet Project desired를 적용하고 실제 field를 readback |
| `POST` | `/api/admin/automation/platform-fleet` | latest Platform Release/approval을 검증·record/reconcile한 뒤 기존 contract Issue/SDK PR plan을 readback-first로 drain |

Config payload는 생성 API 이후 수정 경로가 없다. activation snapshot은 canonical JSON의 SHA-256과
HMAC을 저장하며 resolved manifest가 이를 다시 검증한다. 서명 키가 없거나 값이 맞지 않으면
기존 ACTIVE snapshot도 제공하지 않는다.

Config payload는 UI와 internal API가 같은 strict allowlist validator와 service를 사용한다. 허용 범위는
`schemaVersion`, 비공개 market channel, market별 localization, object-storage asset revision, build pin,
support URL, 공개 cloud identity로만 구성된 `ProjectBlueprint`, 사람 승인 전 `complianceDrafts`다.
ProjectBlueprint의 provisioner는 등록된 `shared/*` logical credential만 참조할 수 있다. 법적 승인,
계정 소유권, 결제·세금·은행·계약, 심사 제출, 공개 배포, credential 값 또는 변경 및 모든 미정의 필드는
fail-closed한다. compliance는 이 계약에서 `DRAFT`만 만들 수 있다. 이전 validator로 만들어진 DRAFT도
activation 시 다시 검사한다.

## ProjectBlueprint와 provider readback

ConfigRevision을 만들 때 `ProjectBlueprint`, `MarketProfile`, `MarketLocalization`, `ComplianceProfile`,
`StoreAsset`을 같은 transaction에서 immutable projection으로 만든다. blueprint는 제품당 production
project, 조직/folder/billing/region, API, IAM 공개 identity, budget, Firebase Auth/App Check/Rules/Indexes/
Functions/앱 등록, GA4·BigQuery, Workspace group·domain-wide delegation을 고정한다.

plan API는 provider에 쓰지 않는다. `ProviderObservation.payload`의 표준 readback envelope는
`visibility=VISIBLE|FORBIDDEN|ERROR`와 `state=PRESENT|ABSENT|UNKNOWN`을 분리한다. 권한 부족과 provider
오류는 반드시 `UNKNOWN`이며 `ABSENT`로 기록할 수 없다. 관측된 desired hash나 공개 identity가 다르면
`DRIFT`, 관측이 없으면 `UNOBSERVED`다. 필요한 shared credential binding이 없거나 같은 capability의
`app/*` 대체 credential만 있으면 전체 plan은 `BLOCKED`다.

plan 출력은 `BLOCKED`, `READY_TO_APPLY`, `COMPLIANT` 중 하나다. `READY_TO_APPLY`는 실행 완료가 아니다.
별도 provider execution을 만들고 Auth Broker가 허용한 shared keyless identity로 실행한 뒤 provider
readback이 들어와야 완료된다.

## Provider execution과 Auth Broker 경계

`ProviderExecution`은 source SHA, ACTIVE config revision, public resource/account identity, desired payload와
hash, primary credential과 fleet read-only credential의 logical ID·credential generation·policy generation,
adapter/origin을 immutable binding hash로 고정한다. secret 값과 Auth Broker lease 원문은 저장하지 않는다.
worker lease는 generation CAS와 1회용 HMAC token hash로 보호하며, stale completion은 거부한다.
mutation용 identity와 readback identity는 logical credential ID와 공개 identity가 모두 달라야 하며,
하나라도 같으면 enqueue 전에 fail-closed한다. 실행 감사 event는 FK `RESTRICT`와 MySQL UPDATE/DELETE
거부 trigger로 append-only를 강제한다. migration principal에 `CREATE TRIGGER` 권한이 없으면 배포가 중단된다.
배포 gate는 migration 적용 뒤 live DB의 trigger를 다시 읽어 계약과 정확히 같은지 확인하며, baseline이나
recovery resolve로 migration row만 성공 처리된 경우에도 trigger가 없으면 fail-closed한다. 관측 principal에
`TRIGGER` 권한이 없으면 MySQL이 빈 결과를 주므로, app verifier는 grant를 먼저 읽어 `FORBIDDEN` 가시성과
리소스 부재를 분리하고 권한 부족을 부재로 기록하지 않는다. 그 경우에도 검증을 건너뛰지 않고, 배포 script가
rollout 이전에 고정 in-cluster verifier의 최신 `PASS` 관측과 계약 digest 일치를 요구한다. CI는 그 관측을
읽기만 하며 verifier workload를 만들거나 바꿀 수 없다.

- `READBACK`은 사전 승인 가능한 fleet inventory identity만 사용한다.
- production mutation, IAM, Workspace domain-wide delegation은 매 실행마다 Backoffice의 app-scoped 사람
  승인과 15분 만료를 요구한다. 승인용 bearer endpoint는 없고 로그인된 trusted UI server action만 있다.
- internal/private market upload만 자동화 범위다. review submit, production/public track, role/key 변경,
  법적·결제·세금·약관 행위는 create schema에 action 자체가 없다.
- mutation 응답 성공도 즉시 `SUCCEEDED`가 아니다. `READBACK_REQUIRED`로 전환하고 별도로 고정한
  read-only credential로 현재 provider 상태를 읽는다. worker 응답 유실도 같은 경로이며 mutation을
  재전송하지 않는다.
- provider visibility `FORBIDDEN`은 resource `ABSENT`와 분리한다. 권한 부족을 리소스 부재로 해석하지 않는다.
- market upload, processing, review, approval, deployment, public 상태는 각각 독립
  `ReleaseGateObservation`으로 남는다.

trusted provider adapter는 `gcp-provisioner-v1`, `firebase-provisioner-v1`, `workspace-provisioner-v1`,
`google-play-api-v1`, `app-store-connect-api-v1`, `ait-cli-v1`의 고정 command envelope만 받아야 한다.
envelope에는 arbitrary executable, argv, env가 없으며 repo ID/source/config/desired/binding/public identity가
들어 있다. 실제 secret 사용은 P2 Auth Broker가 logical credential lease를 발급한 뒤 trusted adapter에
직접 주입한다. worker에는 credential export API와 Kubernetes Secret `get/list/watch` 권한이 없다.

worker에는 DB URL, queue HMAC key, broker mTLS key, run-attestation private key를 넣지 않는다. worker의 모든 claim,
settlement, broker 호출은 별도 `provider-execution-signer` mTLS 경계를 통한다. signer는 DB의 실제 `RUNNING`
execution ID/generation/worker/repository/source/binding/lease expiry를 다시 읽고, 고정 builder가 재구성한 route/body
digest가 일치할 때만 60초 이하의 Ed25519 attestation을 한 번 발급한다. 발급 event에는 nonce digest와 exact
route/body digest를 append-only로 먼저 기록하고 signer가 같은 요청을 broker에 직접 proxy한다. attestation은
worker에 반환되지 않으며 같은 stage/ordinal의 재발급은 durable unique CAS로 거부된다.

signer는 `/internal/control-plane/provider-grants`에 exact singleton P2 rule과 public command digest를 등록하고,
`/internal/control-plane/provider-grants/{id}/verify`에서 policy generation, binding hash, command digest를 다시 확인한다.
둘 중 하나라도 없거나 404, schema mismatch, digest mismatch이면 credential lease를 요청하지 않는다. readback은
같은 grant의 `/internal/control-plane/provider-grants/{id}/observation`에서 exact generation과 binding에 결합된
strict observation만 소비한다. P2 durable nonce journal이 signer의 각 attestation을 broker 재시작 뒤에도 한 번만
소비한다. 같은 generation의 consume 응답이 유실되면 mutation을 재전송하지 않고 새 RESULT attestation으로만
조회한다. 그래도 결과가 불명이면 다음 generation의 `READBACK_FIRST` claim은 `operation=READBACK`과 별도 fleet
readback credential을 다시 검증한 새 grant를 REGISTER→VERIFY→CONSUME 정확히 한 번 실행해 observation을 만든다.
worker는 claim과 envelope의 resume mode가 다르거나 READBACK_FIRST가 READBACK operation이 아니면 중단한다.

운영 활성화 전에는 다음을 모두 readback으로 확인한다.

1. primary/readback `CredentialBinding`의 logical ID, public credential identity, generation, exact origin,
   adapter, auth factor를 catalog와 일치하게 backfill한다.
2. P2 adapter registry/policy에 위 adapter와 capability를 등록하고 signer 전용 mTLS, attestation key, WIF/GSA identity,
   Secret Manager resource binding을 실제 값으로 교차 검증한다.
3. P2에 policy-grant register/verify와 `binding:<bindingHash>` public command resolver, strict observation
   endpoint를 배치한다. secret이나 command를 stdout/argv/env로 전달하지 않는다.
4. canary/fake provider에서 결과 유실, FORBIDDEN/ABSENT, stale generation, approval 만료, credential 회전,
   동일 resource 동시 claim을 통과한 뒤 immutable image digest로 manifest를 렌더한다.
5. 위 조건 전에는 `k8s/provider-execution-worker.yaml`의 signer와 worker `replicas: 0`을 변경하지 않는다. 이 manifest는
   일반 deploy script에서 의도적으로 제외되어 운영 활성화를 우연히 켜거나 끄지 않는다. raw manifest에는
   mutable image가 없으며 renderer가 immutable sha256 digest를 주입한다. worker egress는 DNS와 signer 9443만,
   signer egress는 DNS, P2 broker 8443, MySQL 3306으로만 제한한다.

## Release candidate와 마켓 원장

`ReleaseCandidate`는 다음 값을 한 번에 고정한다.

- GitHub numeric repo ID와 exact source SHA
- ACTIVE ConfigRevision 번호
- market과 BuildTarget key
- artifact type과 SHA-256
- full WorkflowBundle SHA·digest와 exact Platform version

`IMPLEMENTATION`, `CI`, `ARTIFACT`, `RELEASE_ASSETS`, `COMPLIANCE_DRAFT`, `PROVIDER_SHELL`의 최신 observation이
모두 `PASSED`일 때만 lifecycle이 `RELEASE_CANDIDATE`가 된다. 이 상태는 upload나 제출이 아니다.
`UPLOAD`, `PROCESSING`, `DEVICE_QA`, `REVIEW`, `APPROVAL`, `DEPLOYMENT`, `PUBLIC`은 이후에도 서로 독립된
append-only observation으로 남는다. market adapter는 예상 account/team/workspace, app ID, source SHA,
revision, artifact checksum 중 하나라도 다르면 `PROVIDER_IDENTITY_MISMATCH` 또는
`CANDIDATE_BINDING_MISMATCH`로 기록 자체를 거부한다. API는 실행을 durable queue에만 등록하며 요청
스레드에서 provider write를 수행하지 않는다.

중앙 lifecycle은 기존 화면 호환용 6단계 enum과 별도인 `FleetLifecycleState`에
`IDEA → PLANNING → SPEC_REVIEW → APPROVED → BUILD → QA → RELEASE_ASSETS → RELEASE_CANDIDATE → SUBMITTED → REVIEW → APPROVED_FOR_RELEASE → DEPLOYED → PUBLIC_VERIFIED → MONITORED`
순서로 저장한다. 전이 정책은 `src/lib/control-plane/lifecycle-policy.ts` 한 곳에만 있다.

- rank가 줄어드는 전이는 어떤 경로에서도 허용하지 않는다. 새 증거가 이미 더 뒤 단계인 앱을 되돌리지 않는다.
- `IDEA`~`RELEASE_ASSETS`는 자동 관측 증거가 없다. 신뢰된 로컬 사람 UI의 server action만 한 번에 한 단계씩
  전진시키며, `expectedGeneration` 낙관적 동시성, 앱 범위 RBAC, request 단위 idempotency,
  `FleetLifecycleEvent` append-only 원장과 `AuditLog`를 모두 유지한다. bearer API 경로는 열지 않는다.
- `RELEASE_CANDIDATE`는 기존과 같이 필수 6개 gate가 모두 `PASSED`일 때 자동 승격된다.
- 이후 외부 단계는 대응 gate가 전부 `PASSED`이고 candidate 결합(source SHA·config revision·artifact checksum)과
  provider identity 증거가 함께 있을 때만 전진한다.
  `SUBMITTED`는 `UPLOAD`, `REVIEW`는 `PROCESSING`·`DEVICE_QA`·`REVIEW`, `APPROVED_FOR_RELEASE`는 `APPROVAL`,
  `DEPLOYED`는 `DEPLOYMENT`, `PUBLIC_VERIFIED`는 `PUBLIC`을 요구하고, 앞 단계 요구는 누적되므로 관측이 빠진
  단계를 건너뛸 수 없다. `MONITORED`는 같은 공개 identity의 `PUBLIC` `PASSED` 관측이 서로 다른 시점에 두 번
  이상 남아 공개 상태가 계속 관측될 때만 도달한다.
- `UPLOAD`~`DEPLOYMENT`의 `PASSED` 관측은 `providerReference`, `PUBLIC`의 `PASSED` 관측은 `publicIdentity`가
  없으면 `GATE_IDENTITY_REQUIRED`로 기록 자체를 거부한다.
- 라벨, 마일스톤, Project field는 어떤 전이에도 입력으로 쓰지 않는다. 심사 제출·공개 배포·법적·결제 행위는
  이 계약에 action 자체가 없다.

gate 원장에 쓰는 지점은 `appendReleaseGateObservation` helper 하나뿐이다. 범용 요청 경로와 실제 provider
settlement가 같은 transaction 안에서 이 helper만 사용하며 candidate status와 중앙 lifecycle이 함께 갱신된다.
별도 validator나 두 번째 원장을 두지 않는다.

- 범용 `POST /api/control-plane/release-gate-observations`는 release-candidate를 만드는 6개 gate만 기록할 수
  있다. 외부 단계 gate를 임의 `providerReference`/`publicIdentity` 문자열로 요청하면 원장을 하나도 바꾸지 않고
  `EXTERNAL_GATE_PROVIDER_ONLY`로 거부한다. 반대로 release-candidate gate를 provider settlement로 쓰는 것도
  `CANDIDATE_GATE_PROVIDER_FORBIDDEN`으로 막는다.
- 외부 단계 gate는 exact `ProviderExecution` settlement transaction에서만 생성된다. helper는 그 execution이
  `MARKET_RELEASE`이고 같은 release candidate·app·source SHA·config revision·artifact checksum·공개
  account/app identity·`bindingHash`에 결합됐는지, 그리고 같은 settlement에서 만들어진 `ProviderObservation`이
  같은 app·provider·resource에 결합됐는지 다시 읽어 확인한다. 하나라도 다르면
  `PROVIDER_EXECUTION_BINDING_MISMATCH` 또는 `PROVIDER_OBSERVATION_BINDING_MISMATCH`로 settlement 전체가
  롤백된다.
- 저장되는 evidence의 `providerExecutionId`, `providerObservationId`, `providerPolicyGrantId`는 서버가
  파생해 덧붙인다. HTTP 요청 계약에는 이 필드가 없어 호출자가 주입할 수 없다.

### 관측 신뢰 경계

관측 payload는 worker가 만들지 않는다. valid mTLS identity와 살아 있는 claim을 가진 worker라도
provider account/app/source/config/artifact 문자열을 스스로 지어 외부 gate를 전진시킬 수 없어야 한다.

- signer `/v1/settlements` 요청 계약(`providerSignerSettlementRequestSchema`)에는 `observation`,
  `observationReceipt`, `leaseToken` 자리가 없다. 이 key가 하나라도 있으면 DB에 접근하기 전에
  `worker_supplied_observation_rejected`로 끝난다. worker의 `OBSERVED`는 "readback 명령이 성공했으니
  signer가 관측을 직접 읽어라"는 신호일 뿐이다.
- signer는 durable `RUNNING` claim에서 envelope을 다시 구성해 Auth Broker `OBSERVATION` stage를 직접 읽고,
  응답의 policy grant reference(`id`/`digest`/`bindingHash`/`commandDigest`/`policyGeneration`)가 이 execution의
  exact grant와 전부 같을 때만 관측으로 승격한다(`parseTrustedBrokerObservation`).
- worker는 `/v1/broker-requests`로 `OBSERVATION` stage를 호출할 수 없다. 호출할 수 있으면 ordinal 예산을
  소진시켜 signer의 신뢰 관측을 막을 수 있다.
- `settleProviderExecution`은 관측을 동반한 settlement에 broker 영수증을 요구하고, `bindingHash`,
  lease generation, `policyGeneration`, grant id, 재계산한 command digest가 하나라도 다르면
  `PROVIDER_OBSERVATION_RECEIPT_MISMATCH`로 settlement 전체를 롤백한다. 영수증은 settlement hash에
  포함되므로 같은 idempotency key로 다른 영수증을 밀어 넣을 수 없다.
- broker가 아직 관측을 내주지 않으면(204) signer는 `RESULT_UNKNOWN`/`PROVIDER_OBSERVATION_PENDING`으로
  durable requeue한다. 같은 `(execution, generation, stage, ordinal)` attestation은 한 번만 발급되므로
  재시작이나 settlement 재시도는 다음 ordinal로 진행한다.
- signer 응답에는 lease token, attestation, 영수증 capability를 싣지 않는다.

DiscoveryObservation의 `workflowCaller` 필드명은 `profile`, `packageManager`, `workingDirectory`다.
profile은 `react-native | godot`이고 workingDirectory는 repository 상대 경로만 허용한다. React Native는
packageManager를 `npm | pnpm`으로 확정해야 하며, 자체 package manager 계약이 없는 Godot은 반드시 `null`이다.
resolved manifest는 요청한 exact source SHA의 세 값 중 하나라도 없거나 계약 밖이면
`NO_WORKFLOW_CALLER_FOR_SHA`로 중단하고 추측하지 않는다.

## Platform Fleet

매분 RPI5 `backoffice-platform-fleet` CronJob과 배포 직후 catch-up Job은 같은 admin endpoint를 호출한다.
producer는 GitHub App의 read-only API로 `seorilabs/platform` latest Release의 정확한 tag commit,
`platform-release.json`, `fleet-approved.json`, TypeScript `.tgz`, GDScript artifact와 checksum asset을 읽는다.
raw byte SHA-256, release asset size/digest, release tag/source SHA가 하나라도 다르면 아무 release나 plan을 만들지
않는다. TypeScript `.tgz`가 Release asset에 없으면 fail-closed하며, 실제 내려받은 동일 bytes의 SHA-256·size와
consumer lock의 exact version·integrity를 결합해 관측한다.

`fleet-approved.json`은 P3 RN/Godot static·build-only canary와 exact WorkflowBundle SHA·digest를 포함하고,
ConfigMap `backoffice-platform-fleet-trust`의 `trusted-release-keys.json`에 등록된 ACTIVE Ed25519 공개키로
서명이 검증되어야 한다. 승인 asset이 아직 없으면 endpoint는 `WAITING_APPROVAL`을 반환하고 DB write와
reconcile을 모두 생략한다. 승인 asset은 있는데 trust root가 없거나 서명이 틀리면 fail-closed한다.
공개키 ConfigMap은 canonical SPKI `BEGIN PUBLIC KEY` PEM만 허용한다. secret이 아니며 PKCS8 private signing
key나 임시 대체키를 Backoffice에 두지 않는다.

검증된 producer는 source SHA, contract revision, TypeScript/GDScript exact artifact version·SHA-256,
GDScript tree checksum, 변경 분류, 승인 canary attestation, WorkflowBundle SHA·digest와 raw/approval provenance를
중앙 snapshot signature에 고정한다. Backoffice는 이 정규화 입력을 append-only `PlatformRelease`로 기록한다.
ACTIVE app cohort는 이 불변 release manifest에 넣지 않고 reconcile 시점의 mutable current snapshot으로 읽는다.
따라서 앱 추가·중단이 release identity를 바꾸지 않으며, 매 reconcile은 현재 ACTIVE app 전부를 요구한다.
GDScript는 고정 HTTPS release asset URL이 필수이며 floating branch는 계약에 들어올 수 없다.

Repository discovery는 exact source SHA에서 RN의 고정 `@seorilabs/platform-sdk` version과 lock integrity,
Godot의 vendored `SOURCE`/`VERSION`/`CHECKSUM`과 실제 tree checksum을 자동 관측한다. 범위·branch·git URL,
lock 불일치, floating `main`, tree checksum 불일치, addon subtree gitlink는 `CUSTOM_HTTP`, SDK 자체가 없으면 `MISSING`으로
분류한다. 현재 release의 exact package version·lock integrity 또는 fixed asset URL·검증된 tree가 일치할 때만
approved digest와 contract revision을 얻고, 이전 exact SDK는 digest를 추측하지 않은 채 update 대상으로 남는다.
lockfile만 1MiB bounded read를 허용하고 다른 discovery 설정 파일은 기존 256KiB 한도를 유지한다.
ACTIVE app 중 numeric repo ID가 없거나 current default HEAD discovery가 `NEEDS_INPUT`이거나 Platform evidence가
없는 repo가 하나라도 있으면 producer는 consumer를 누락하지 않고 전체 cohort를 중단한다.

Reconcile input은 DB에서 다시 읽은 현재 ACTIVE app 전체 cohort와 각 repo의 current default HEAD
`DiscoveryObservation`, `provider=platform/resourceType=platform-consumer` observation ID를 정확히
지정해야 한다. subset, stale source, 다른 app/provider identity, digest 또는 signature 불일치는 전부
fail-closed한다.

- `IMPLEMENTATION_ONLY` drift는 release/repo당 `SDK_UPDATE_PR` plan과 `AgentRun.taskInput` 하나만 만든다.
  기존 agent lease·`repo-pr:{owner/repo}` unique guard를 그대로 사용하며 task는 exact version/digest,
  source SHA, manifest marker와 필수 check를 포함한다.
- `CONTRACT_CHANGE` 또는 `CONTRACT_ADDITION` drift는 영향 repo마다 P1 Issue plan 하나를 만든다.
  label은 `P1`, `autopilot`, `platform`, `platform-contract`로 고정된다.
- `CUSTOM_HTTP`와 `MISSING` 관측은 각각 `CUSTOM_UNMANAGED`, `MISSING_UNMANAGED`로 표시하며 자동
  호환으로 추측하지 않는다.

Issue mutation은 installation GitHub App adapter에서 marker 조회, create, exact readback 순서로만
수행한다. create 결과가 불명이면 marker를 먼저 다시 읽고 새 Issue를 만들지 않는다. SDK PR은 generic
worker가 capability broker를 통과해 처리하며 `RESULT_UNKNOWN`이면 같은 run이 `READBACK_FIRST`로
재claim될 때까지 repo guard를 유지한다. Project field는 이 queue의 claim source가 아니다.

ReleaseCandidate 생성은 해당 repo에 적용되는 최신 `FLEET_APPROVED` release와
`PlatformFleetBinding`의 release ID, manifest digest, source SHA, version, artifact digest,
contract revision 및 `COMPLIANT` 상태가 모두 일치하고 candidate의 WorkflowBundle SHA·digest가 승인 canary와
exact match할 때만 열린다. PR merge만으로 compliant로 승격하지
않고 새 exact provider observation과 reconcile을 요구한다. Fleet UI에는 observed/approved
version·digest, contract revision, PR/P1 Issue, 예외 만료와 plan 원장을 표시한다.

## 운영 UI와 재인증 경계

앱 워크스페이스의 `Fleet` 탭은 DiscoveryObservation, ACTIVE/DRAFT ConfigRevision,
ProjectBlueprint와 market projection, ReleaseCandidate와 독립 gate, ProviderObservation,
PlatformFleetBinding, CredentialBinding, ProviderExecution, AgentRun/dead-letter와 ReauthRequest를 한 화면에서 조회한다.
CredentialBinding에는 logical ID, 공개 account identity, fingerprint와 scope만 있으며 secret 값을
저장하거나 변경하는 endpoint는 없다.

ReauthRequest는 strict gate enum만 저장하고 공개 설명은 서버의 고정 mapping으로 파생한다. provider
error나 DOM free-form text를 받거나 저장하지 않는다. `HUMAN_REAUTH_REQUIRED → TRUSTED_LOCAL_PENDING`은
사람이 로그인한 Backoffice UI에서 app-scoped write RBAC를 통과한 server action으로만 기록한다.
control-plane bearer endpoint는 이 전이를 제공하지 않는다. 이 상태는 로그인 수행이나 성공 판정이
아니다. Backoffice에는 비밀번호, TOTP, passkey, SMS/push 승인, cookie, recovery code 입력 UI가 없다.

## Queue 불변식

- claim은 `AgentRun.status`와 `leaseGeneration`을 같은 transaction에서 CAS한다.
- `AgentRepoGuard.activeScopeKey=repo-pr:{owner/repo}`의 nullable unique index로 lease TTL과 무관하게 repo별 자율 PR 실행을 하나로 제한한다.
- `PR_READY` 완료 뒤에도 guard를 유지한다. 정확한 PR이 `CLOSED` 또는 `MERGED`로 mirror/readback된 뒤에만 해제한다.
- claim 직전에 현재 `IssueMirror`의 closed, `blocked`, `approval:*`, `no-autopilot`, `autopilot` 상태와 기존 open autopilot PR을 다시 확인한다.
- token 원문은 저장하지 않는다. DB에는 SHA-256만 저장하고 같은 idempotency 요청의 token은 server-only HMAC으로 재생성한다.
- heartbeat와 settle은 worker ID, token hash, generation, TTL을 모두 대조한다. 이전 generation의 completion은 거부한다.
- PR 생성 권한 lease의 만료와 `RESULT_UNKNOWN`은 기존 lease를 폐기하고 run을 durable readback 대기로 전환한다. 다음 claim만 새 generation의 `READBACK_FIRST` capability를 발급하며, 이전 token의 resolution은 거부한다.
- routine의 `approvalPolicy`, `budgetCeilingMicros`, 누적 `spentMicros`, 남은 예산과 허용 action capability는 claim에 포함된다. 모든 settlement는 `costMicros`가 필수이고 누적 예산 초과 및 `READ_ONLY`의 mutation 결과를 fail-closed한다.
- 취소가 외부 결과 불명을 만들지 않으면 `workKey`도 같은 transaction에서 해제한다. 결과 불명 또는 active repo guard가 남은 dead-letter는 수동 retry로 우회할 수 없다.

## Scheduler와 Project projection

GitHub delivery와 allowlist된 Issue observation 또는 정식 tag의 공개 ref·source SHA·checksum `AutomationIngressEvent`는 같은 transaction에 기록한다. scheduler는 Issue 재처리마다 GitHub API로 현재 상태를 readback하고 durable observation보다 오래되지 않았음을 확인한 뒤 IssueMirror를 수렴시킨다. 구형 payload 없는 Issue inbox도 같은 readback 경로로 복구한다. 정식 tag는 같은 inbox에서 출시노트를 재생하되 `${GITHUB_ORG}/platform`은 immutable Platform publisher의 소유권을 보존하기 위해 외부 발행 없이 처리 완료한다. scheduler는 실패·중단된 inbox와
마지막 occurrence 이후의 UTC schedule slot을 재소진하며 delivery source key, definition/slot unique key,
issue work key로 중복 occurrence와 run을 막는다. pause 기간은 resume anchor로 건너뛰므로 재개가 과거 slot을
한꺼번에 실행하지 않는다.

`Priority`, `App`, `Kind`, `Lifecycle`, `Agent`, `Approval`, `Outcome`은
`FleetProjectProjection.desired`에만 투영된다. claim은 GitHub Issue mirror와 queue 상태만 읽으며 Project field를
실행 신호로 사용하지 않는다. Project write 직전 current app binding을 다시 확인하고 stale binding은 `SUPERSEDED`로 닫는다. Project write 뒤 실제 field를 다시 읽어 current relation CAS가 일치할 때만 `APPLIED`로 기록한다.
Project ID나 permission이 없으면 추측·권한 확대 없이 `NEEDS_INPUT` 또는 `READBACK_REQUIRED`로 남긴다.

`FleetProjectProjection` drain은 정기 scheduler CronJob `backoffice-fleet-project-projection`과 배포
catch-up Job이 각각 `/api/admin/automation/project-projections`를 한 번씩 호출해 소진한다. 두 경로가 겹쳐도
claim CAS가 한 projection을 한 번만 적용하며, `App.projectV2Id`가 아직 없으면 추측하지 않고 `NEEDS_INPUT`으로
닫는다. `k8s/scheduler-cronjobs.yaml`의 CronJob은 `suspend: false`로 배포 스크립트가 직접 apply한다.
`Seorilabs Fleet` Project 생성과 `App.projectV2Id` 설정은 사용자 승인이 필요한 별도 gate다.

Platform Fleet scheduler는 기존 plan의 drain/readback을 producer보다 먼저 별도 오류 경계에서 실행한다.
새 Release 조회나 asset 검증이 실패해도 기존 mutation readback은 이미 독립적으로 소진되며, drain 실패 또한
producer 실행 자체를 생략시키지 않는다.

## GitHub repository webhook

`repository`의 created, renamed, archived, unarchived, edited와 default-branch `push`를
`RepositoryRegistration`에 repo numeric ID 기준으로 upsert한다. 이미 관리 중인 repo rename만
GitHub readback까지 통과한 뒤 `App.repoFullName`과 slug에 반영한다. 아직 stack이 확정되지 않은 신규
repo는 App을 추측 생성하지 않는다.

webhook은 source를 직접 읽지 않는다. 같은 transaction에서 delivery와 공개 discovery payload를 inbox에
봉인하고 registration을 `REGISTERED`로 내려 기존 generation의 QUEUED/RUNNING lease를 즉시 `STALE`로
만든다. scheduler가 provider의 현재 numeric repository ID, canonical full name, private/fork/archive/default
branch와 HEAD를 readback한 뒤 그 vector로만 `RepositoryDiscoveryRun` generation을 enqueue한다. delivery
ID가 달라도 동일 generation의 normalized request hash가 같으면 기존 run으로 접는다. 전용 worker가
numeric repository ID, canonical full name, private/fork/archive/default
branch와 현재 `main` HEAD를 provider에서 다시 읽은 뒤 exact commit tree만 탐색한다. default push SHA와
현재 HEAD가 다르거나 탐지 중 HEAD가 움직이면 이전 run은 `STALE`로 닫고 current HEAD를 새 generation으로
enqueue한다. 만료 worker의 완료는 `leaseGeneration`과 registration generation CAS에서 거부된다.

탐지 파일은 verified tree에서 선택한 `package.json`, `project.godot`, native build identity,
`export_presets.cfg`, `build.env`, `granite.config.ts`로 제한한다. 원문은 parser 호출 동안만 유지하며 DB에는
path, blob SHA, content SHA-256, size, 상태와 파생된 공개 package/bundle/app ID만 저장한다. tree 전체 path와
source 원문, secret-like custom package field는 저장하지 않는다. tree path는 absolute/backslash/NUL/dot
segment를 거부하고 512자·64 segment 상한을 적용한다. 이 상한 안의 vendored xcframework 경로는 정상 tree로
수용하며 실제 source read는 위 allowlist와 파일별 byte 상한을 그대로 적용한다.

- 후보 하나: `classification=PRODUCT_APP`, `App.status=ACTIVE` 신규 등록,
  `RepositoryRegistration.status=MANAGED`, exact-SHA
  `DiscoveryObservation`을 하나의 transaction으로 완료한다.
- 중앙 정책의 `.github`, credentials, bot, Backoffice, presentations 저장소는 `INFRA_REPO`, planning,
  공식 웹사이트와 starter template은 `EXCLUDED`로 terminal 분류하며 App row를 만들지 않는다. 정책 밖의
  후보 0개/여러 개는 인프라로 추측하지 않고 이유 코드가 있는 `NEEDS_INPUT`으로 닫는다.
- package manager 모호성, build target 누락, 서로 다른 공개 identity 복수 관측, unreadable source, 미승인
  public 또는 non-main repo도 `NEEDS_INPUT`이다. target은 exact source에 존재하지만 package ID, bundle ID,
  AppsInToss appName이 동적이거나 아직 확정되지 않았으면 registration을 막지 않고 nullable `BuildTarget` fact로
  기록한다. release candidate와 resolved manifest는 source identity 또는 같은 앱의 exact provider application
  binding이 있어야 한다. Google Play와 App Store는 `application`, AppsInToss는 `mini-app` binding만 허용하며
  `externalId`와 non-null `publicIdentity`가 같은 공개 build identity여야 한다. 복수 application binding,
  source와 provider identity 불일치, `publisher-account`/`team`/`workspace` 일반 계정 binding은 전부
  fail-closed한다. 공개 제품 allowlist는 source discovery만 허용하며 public PR의 ARC 실행 권한을 뜻하지 않는다.
- `App.marketTargets`는 legacy desired state이고 `BuildTarget`은 exact-source observation이다. 두 집합 차이는
  identity conflict가 아니며 adoption은 기존 desired target과 새 discovered target을 비파괴 union한다. source에서
  제거된 target은 이전 row를 지우지 않고 새 source SHA 조회에서 제외해 exact observation으로 표현한다.
- fork는 exact provider fact와 request hash에 남기지만 `PRODUCT_APP` 또는 `PLATFORM_PRODUCER`로 자동
  승격하지 않는다. `NEEDS_INPUT`에서 사람이 `EXCLUDED`로 확인한 경우에만 새
  append-only decision revision으로 terminal 재검증한다.
- `seorilabs/platform`은 `seorilabs-platform` package와 `spec/openapi.yaml`을 함께 확인한 뒤
  `PLATFORM_PRODUCER`로 관리하며 RN/Godot App 후보에서 명시적으로 제외한다.
- default push와 repository lifecycle webhook은 공개 numeric repo identity, ref, SHA를 delivery와 같은
  transaction의 automation inbox에 checksum으로 봉인하고 기존 실행을 즉시 fail-closed한다. inbox 처리는
  GitHub의 현재 repository identity와 HEAD를 다시 읽어 오래되거나 순서가 뒤집힌 payload를 적용하지 않는다.
  scheduler는 GitHub redelivery에 의존하지 않고 FAILED/PENDING inbox를 재처리하며, 기존 ingress-only row도
  동일 payload 검증 뒤 delivery 원장과 멱등 복구한다.

worker replica는 RPI5에 1개, poll은 2초, lease는 90초이며 exact source file read 전에 갱신한다. 최대 시도는 3회다.
durable enqueue와 실행 차단은 webhook transaction에서 즉시 완료하고, provider readback 뒤 discovery run을
등록한다. 10분을 넘긴 non-terminal run은 `DISCOVERY_SLO_EXCEEDED`로 `NEEDS_INPUT` 종료한다. 따라서
신규 private RN/Godot repo의 5분 등록/10분 bootstrap 또는 정확한 needs-input SLO를 DB의 createdAt,
completedAt, reasonCode로 자동 검증할 수 있다.

webhook 누락은 hourly `backoffice-repository-discovery-backfill`이 보정한다. GitHub App installation의
App-JWT readback이 조직 전체 저장소 설치(`repository_selection=all`)와 정확한 조직 account임을 확인한 뒤
전체 repository numeric ID를 pagination하고 `GET /repositories/{id}`로 canonical name, private/fork/archive,
default branch를 다시 읽고 active private repository와 중앙 정책이 허용한 public repository의 exact default
HEAD를 결합한다. 따라서 public 저장소의 누락된 push도 다음 hourly sweep에서 새 source generation으로
복구된다. sweep occurrence와
공개 vector의 checksum이 synthetic reconcile delivery ID이며, 다른 sweep에서 같은 current vector가
재관측돼도 normalized request hash로 기존 generation에 접힌다. 반면 A→B→A처럼 예전 vector가 다시
나타나면 새 occurrence delivery가 새 generation을 만들 수 있다. canonical identity, visibility,
default branch, archive state 또는 HEAD vector 변경만 current generation을 바꾸며, source read는 기존 worker의
`leaseGeneration` CAS, 최대 3회 retry, append-only audit를 그대로 사용한다. backfill은 항상 `shadow`이고
GitHub settings, caller, secret, Environment, ruleset, Issue 또는 PR을 쓰는 adapter를 호출하지 않는다.

같은 backfill occurrence는 App-JWT의 공개 installation ID, app ID, 조직 account, repository selection,
permission grant, subscribed event와 suspended 상태를 앱별 `ProviderObservation` 및
`github-app-installation-repository` `ExternalBinding`으로 남긴다. Fleet UI의 `GitHub App Gate 1 권한`은
caller bootstrap PR, Issue fan-out, required check, workflow dispatch, Environment, 조직 variable/secret,
custom property와 조직 ruleset에 필요한 exact grant/event의 누락을 표시한다. `GRANTED`는 installation이
그 권한을 가지고 있다는 readback일 뿐이며 실행 승인, 설정 변경 또는 mutation 성공을 뜻하지 않는다.
이 단계에서 GitHub에는 installation/repository GET만 수행한다.

## 중앙 desired-state DRAFT backfill

hourly `backoffice-desired-state-backfill`은 모든 `App.status=ACTIVE` row를 cohort로 고정한다. repoId가 없는
기존 앱도 제외하지 않고 `APP_REPO_ID_MISSING`으로 표시한다. exact current
`RepositoryRegistration.classification=PRODUCT_APP`, `DiscoveryObservation`, 같은 SHA의 BuildTarget이 모두
맞을 때만 확인된 market과 internal/private/TestFlight channel을 새 ConfigRevision `DRAFT`로 만든다.
registration과 run은 `repository-discovery/v5`를 함께 저장하므로 legacy terminal run은 hourly sweep에서
새 generation으로 재탐지되며 이름만 바꾼 분류로 간주되지 않는다.
ConfigRevision은 `sourceObservationId` FK와 backfill contract version을 보존하고 app row lock 아래 revision을
할당한다. 같은 observation의 동시 실행은 unique key와 stable idempotency key로 하나만 생성된다.

이 worker와 API에는 activation 호출과 provider/GitHub adapter가 없다. locale을 알 수 없으면 빈 목록으로
두며 localization 문구, ProjectBlueprint의 조직/folder/billing/project, compliance, StoreAsset checksum은
source/provider evidence가 완전하지 않은 한 만들지 않는다. 특히 법적 선언, 계정 소유권, 결제·세금,
심사 제출과 공개 배포 승인은 자동 생성하거나 활성화하지 않는다. `/settings`는 repository classification,
DRAFT 가능/기존 설정/needs-input 수와 이유를 함께 표시한다. 같은 설정 화면과 internal API는 동일한 strict
validator와 transaction service를 사용한다. nullable expand column의 `classificationDecisionVersion=null`은
revision `0`으로만 해석하며 분류 결정은 이 revision CAS와 idempotency
key를 요구하고 이전 revision을 수정하지 않으며 audit에는 공개 repo/candidate identity만 남긴다.

배포 catch-up은 full-org discovery enqueue가 성공한 뒤 현재 generation의 provider readback이 terminal 상태가
될 때까지 drain한다. `FAILED`, 재enqueue 없이 남은 `STALE`, 누락 current run은 성공으로 숨기지 않는다.
두 번의 terminal readback 뒤에만 중앙 DRAFT backfill을 실행하며 세 단계 중 하나라도 실패하면 catch-up Job과
배포가 실패한다. 정기 scheduler 자체는 삭제하거나 suspend하지 않는다.

## 중앙 모델의 zero-state 의미

- `MarketProfile`, `MarketLocalization`, `ComplianceProfile`, `StoreAsset`, `ProjectBlueprint`는
  `ConfigRevision` projection이다. ConfigRevision이 없으면 0이 정상이며, exact legacy shadow import가 만든
  DRAFT는 같은 transaction에서 표현 가능한 market/localization만 materialize한다. shadow DRAFT는 직접
  ACTIVE로 전환할 수 없다.
- exact discovery backfill DRAFT는 확인된 MarketProfile만 materialize하며 source observation provenance를
  FK로 보존한다. 이 DRAFT도 자동 활성화하지 않는다.
- `ProjectBlueprint`, compliance 및 asset은 legacy source에 필요한 공개 desired state가 완전하게 있을 때만
  사람이 검토 가능한 새 DRAFT에 포함한다. 조직/folder/billing, 법적 선언, object storage checksum이나
  provider 상태를 App/Discovery 필드에서 추측하지 않는다.
- `ProviderObservation`과 `ExternalBinding`은 provider GET/readback producer가 실행된 경우에만 생긴다.
  GitHub installation readback은 위 hourly backfill이 공급하지만 GCP/Firebase/Workspace/마켓 readback은
  각 provider의 read-only identity가 연결되기 전까지 0이 정상이다.
- `CredentialBinding`은 catalog의 logical ID, 공개 identity/fingerprint, scope, generation, adapter/origin을
  모두 검증한 import가 들어오기 전까지 0이며, catalog 목적이나 파일 경로만으로 capability를 추측하지 않는다.
- `ReleaseCandidate`와 `ReleaseGateObservation`은 ACTIVE revision, exact source, artifact checksum,
  WorkflowBundle SHA, Platform version 및 독립 gate evidence가 생긴 뒤에만 기록한다. 코드/빌드가 있다는
  이유로 release candidate나 upload/public 상태를 합성하지 않는다.

## 이관 경계

이 migration은 additive다. Play/App Store/AppsInToss JSON, `market-launch-state.json`,
Platform registry와 `.seorilabs/*` consumer는 계속 동작한다. 두 번의 shadow parity와 build-only gate,
서명 snapshot 복구 검증 전에는 기존 consumer를 삭제하지 않는다.

이 변경의 merge는 production migration 적용이나 배포를 의미하지 않는다. migration 적용, signing key
검증, 배포와 readback은 별도 rollout gate에서 수행한다.

## Legacy 종료 전 두 게이트

### 1. 복구 rehearsal

목적은 백업 파일이 존재한다는 사실이 아니라 **백오피스가 사라져도 그 파일로 다시 켤 수 있음**을
증명하는 것이다. 운영 DB에는 연결하지 않는다. `restore-rehearsal-job.yaml`은 선택한 verified dump를
read-only PVC에서 읽어 Pod 내부 MySQL 9.2 `emptyDir`에 복원하고 다음을 한 번에 확인한다.

- 현재 migration/history/schema와 복구 전후 data fingerprint가 같다.
- production app/backup principal에는 `TRIGGER` 권한을 주지 않으므로 logical dump는 trigger DDL을
  명시적으로 제외한다. 보호 table의 trigger가 0건인 경우에만 exact source 계약 두 개를 Pod 내부 DB에
  재구성하고 다시 검증한다. 부분 설치·변형·추가 trigger는 자동 수정하지 않고 fail-closed한다.
- 복구 DB로 production Backoffice server가 Ready가 되고 resolved manifest를 HTTP로 재생한다.
- 모든 ACTIVE snapshot 서명이 맞고 잘못된 키와 DRAFT는 기존 resolve 경계에서 거부된다.
- signing key는 broad `backoffice-secrets`가 아니라 exact key 하나만 가진 전용 Secret volume에서 읽는다.
  전용 SealedSecret이 live에 적용되지 않았으면 web activation과 rehearsal은 fail-closed하며 다른 Secret으로
  대체하지 않는다.
- verifier는 SHA, count, digest, trigger 복구 mode와 성공 여부만 출력한다. production DB URL/password는
  Pod에 주입하지 않는다.
- verifier 종료 시 MySQL을 내리고 Pod-scoped `emptyDir`을 폐기한다. Job은 감사용 metadata만 7일 보존한다.
- terminal Failed condition은 전체 timeout을 기다리지 않고 즉시 실패로 반환한다.

실행은 배포된 exact image digest, source SHA, 검증된 dump basename을 고정한다.

```bash
BACKOFFICE_IMAGE='registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:<digest>' \
BACKOFFICE_SOURCE_SHA='<40자리 SHA>' \
BACKOFFICE_RESTORE_DUMP_BASENAME='backoffice-YYYYMMDDTHHMMSSZ.sql.gz' \
  scripts/run-restore-rehearsal.sh
```

이 Job 성공은 백업 복구 게이트만 닫는다. production DB 변경이나 legacy 파일 삭제 승인이 아니다.

### 2. Fleet parity 두 회차

한 회차는 현재 `ACTIVE` 앱 중 repository registration이 `MANAGED`인 전체 cohort를 먼저 고정한다.
각 앱의 latest Discovery source SHA, ACTIVE Config revision, transform contract를 그대로 사용해 old JSON과
Backoffice 결과를 비교한다. Job UID가 occurrence key라 container retry는 새 회차로 세지 않는다.

```bash
BACKOFFICE_IMAGE='registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:<digest>' \
BACKOFFICE_SOURCE_SHA='<40자리 SHA>' \
  scripts/run-fleet-parity-wave.sh
```

- 앱 하나라도 `MISMATCH`, `NEEDS_INPUT`, source 부족 또는 identity 오류면 wave 전체가 `BLOCKED`다.
- `market-launch-state.json`의 provider 상태 모호성도 `NEEDS_INPUT`으로 남으며 제외하거나 성공으로 바꾸지 않는다.
- 서로 다른 두 Job에서 cohort와 exact vector가 동일하고 모든 앱이 `FULL MATCH`일 때만
  `consecutiveMatchCount=2`, `cleanupAllowed=true`가 된다.
- 중간에 차단 wave, source SHA, ACTIVE revision, contract 또는 cohort가 바뀌면 연속 횟수는 초기화된다.
- UI의 `cleanupAllowed`는 parity 선행조건만 뜻한다. restore 및 선언 마켓 build-only gate 없이 삭제하지 않는다.
