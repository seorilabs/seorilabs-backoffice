# Fleet Control Plane v1

이 문서는 기존 앱별 JSON consumer를 유지한 채 shadow로 도입한 첫 vertical slice의 운영 계약이다.
이 단계는 provider 쓰기, 마켓 제출, 공개 배포, credential 값 저장·조회 기능을 제공하지 않는다.

## 인증과 공통 헤더

- 제어면 API: `Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN`
- agent queue API: `Authorization: Bearer $AGENT_WORKER_TOKEN`
- 모든 요청: `X-Seori-Principal`에 workload identity 공개 ID
- 모든 mutation: 8자 이상의 `Idempotency-Key`
- Config activation과 resolved manifest: `CONTROL_PLANE_SNAPSHOT_SIGNING_KEY`
- agent claim: worker에 노출하지 않는 `AGENT_LEASE_SIGNING_KEY`

토큰 audience를 분리하며, audit에는 principal, logical entity ID, digest와 공개 식별자만 남긴다.
payload·result에는 비밀번호, TOTP seed, cookie, API key, receipt 또는 개인 식별자를 넣지 않는다.

## API

| Method | Path | 계약 |
| --- | --- | --- |
| `POST` | `/api/control-plane/discovery-observations` | 정확한 40자리 source SHA의 탐지 결과, strict `workflowCaller`, build target projection 기록 |
| `POST` | `/api/control-plane/provider-observations` | provider readback과 공개 external binding 기록 |
| `POST` | `/api/control-plane/config-revisions` | immutable `DRAFT` revision 생성 |
| `POST` | `/api/control-plane/config-revisions/activate` | `expectedActiveRevision` CAS로 `DRAFT → ACTIVE`, 이전 ACTIVE는 `SUPERSEDED` |
| `GET` | `/api/control-plane/apps/{repoId}/resolved-manifest?ref={sha}&market=&revision=` | exact SHA observation의 `workflowCaller`와 서명 검증된 config snapshot 조립 |
| `GET` | `/api/control-plane/apps/{repoId}/project-blueprint-plan?ref={sha}&revision=` | exact SHA와 ACTIVE revision의 GCP/Firebase/Workspace plan 및 readback 상태 계산. provider write 없음 |
| `POST` | `/api/control-plane/release-candidates` | source SHA, ACTIVE config, market target, artifact checksum, WorkflowBundle SHA, Platform version을 하나의 candidate로 고정 |
| `POST` | `/api/control-plane/release-gate-observations` | candidate에 결합된 독립 gate observation append |
| `GET` | `/api/control-plane/reauth-requests?repoId=` | 앱 범위의 공개 reauth gate와 대기 상태 조회 |
| `POST` | `/api/control-plane/reauth-requests` | 비밀값 없이 `HUMAN_REAUTH_REQUIRED` append |
| `POST` | `/api/internal/agents/claim` | 최대 5분 lease와 generation capability 발급 |
| `POST` | `/api/internal/agents/heartbeat` | 현재 generation lease만 연장 |
| `POST` | `/api/internal/agents/complete` | 현재 generation을 성공 종료 |
| `POST` | `/api/internal/agents/fail` | attempt 한도 내 재큐잉, 초과 시 dead-letter |
| `POST` | `/api/internal/agents/readback-required` | 외부 mutation 결과 불명을 기록하고 같은 run guard를 유지 |
| `POST` | `/api/internal/agents/readback` | 원래 lease capability로 `RESUME`, `COMPLETE`, `BLOCKED` 판정 |
| `POST` | `/api/control-plane/automation-definitions` | agent, cadence, 예산 상한, 승인 정책이 고정된 routine 생성 |
| `POST` | `/api/control-plane/automation-definitions/{id}/commands` | 즉시 실행, pause/resume, run cancel/dead-letter retry |
| `POST` | `/api/admin/automation/schedule` | webhook inbox, 누락 schedule, 만료 lease, terminal PR guard 조정 |
| `POST` | `/api/admin/automation/project-projections` | Fleet Project desired를 적용하고 실제 field를 readback |

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

이 slice의 출력은 `BLOCKED`, `READY_TO_APPLY`, `COMPLIANT` 중 하나다. 실제 shared keyless provisioner
apply와 provider API readback은 별도 승인·실행 gate다.

## Release candidate와 마켓 원장

`ReleaseCandidate`는 다음 값을 한 번에 고정한다.

- GitHub numeric repo ID와 exact source SHA
- ACTIVE ConfigRevision 번호
- market과 BuildTarget key
- artifact type과 SHA-256
- full WorkflowBundle SHA와 exact Platform version

`IMPLEMENTATION`, `CI`, `ARTIFACT`, `RELEASE_ASSETS`, `COMPLIANCE_DRAFT`, `PROVIDER_SHELL`의 최신 observation이
모두 `PASSED`일 때만 lifecycle이 `RELEASE_CANDIDATE`가 된다. 이 상태는 upload나 제출이 아니다.
`UPLOAD`, `PROCESSING`, `DEVICE_QA`, `REVIEW`, `APPROVAL`, `DEPLOYMENT`, `PUBLIC`은 이후에도 서로 독립된
append-only observation으로 남는다. market adapter는 예상 account/team/workspace, app ID, source SHA,
revision, artifact checksum 중 하나라도 다르면 `PROVIDER_IDENTITY_MISMATCH` 또는
`CANDIDATE_BINDING_MISMATCH`로 기록 자체를 거부한다. API는 provider write를 수행하지 않는다.

중앙 lifecycle은 기존 화면 호환용 6단계 enum과 별도인 `FleetLifecycleState`에
`IDEA → PLANNING → SPEC_REVIEW → APPROVED → BUILD → QA → RELEASE_ASSETS → RELEASE_CANDIDATE → SUBMITTED → REVIEW → APPROVED_FOR_RELEASE → DEPLOYED → PUBLIC_VERIFIED → MONITORED`
순서로 저장한다. 새 release-candidate 증거가 이미 더 뒤 단계인 앱을 되돌리지 않는다.

DiscoveryObservation의 `workflowCaller` 필드명은 `profile`, `packageManager`, `workingDirectory`다.
profile은 `react-native | godot`, packageManager는 `npm | pnpm`, workingDirectory는 repository 상대 경로만
허용한다. resolved manifest는 요청한 exact source SHA의 세 값 중 하나라도 없거나 계약 밖이면
`NO_WORKFLOW_CALLER_FOR_SHA`로 중단하고 추측하지 않는다.

## 운영 UI와 재인증 경계

앱 워크스페이스의 `Fleet` 탭은 DiscoveryObservation, ACTIVE/DRAFT ConfigRevision,
ProjectBlueprint와 market projection, ReleaseCandidate와 독립 gate, ProviderObservation,
PlatformFleetBinding, CredentialBinding, AgentRun/dead-letter와 ReauthRequest를 한 화면에서 조회한다.
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
- 만료 lease는 같은 run을 retry 또는 dead-letter로 수렴시키며 모든 전이는 `AgentRunEvent`에 append한다. 결과 불명은 새 Issue/PR을 만들지 않고 readback 뒤 같은 run을 재개한다.
- routine의 `approvalPolicy`와 `budgetCeilingMicros`는 claim에 포함된다. `READ_ONLY`의 PR 결과와 예산 초과 완료는 fail-closed한다.

## Scheduler와 Project projection

GitHub delivery와 `AutomationIngressEvent`는 같은 transaction에 기록한다. scheduler는 실패·중단된 inbox와
마지막 occurrence 이후의 UTC schedule slot을 재소진하며 delivery source key, definition/slot unique key,
issue work key로 중복 occurrence와 run을 막는다. pause 기간은 resume anchor로 건너뛰므로 재개가 과거 slot을
한꺼번에 실행하지 않는다.

`Priority`, `App`, `Kind`, `Lifecycle`, `Agent`, `Approval`, `Outcome`은
`FleetProjectProjection.desired`에만 투영된다. claim은 GitHub Issue mirror와 queue 상태만 읽으며 Project field를
실행 신호로 사용하지 않는다. Project write 뒤 실제 field를 다시 읽어 일치할 때만 `APPLIED`로 기록한다.
Project ID나 permission이 없으면 추측·권한 확대 없이 `NEEDS_INPUT` 또는 `READBACK_REQUIRED`로 남긴다.

실제 scheduler CronJob, Codex/Claude 예약 작업, `Seorilabs Fleet` Project 생성은 배포와 사용자 승인 이후의
별도 gate다. 저장소의 설치 manifest는 `suspend: true`이며 운영 workload에 포함되지 않는다.

## GitHub repository webhook

`repository`의 created, renamed, archived, unarchived, edited와 default-branch `push`를
`RepositoryRegistration`에 repo numeric ID 기준으로 upsert한다. 이미 관리 중인 repo rename만
`App.repoFullName`과 slug에 반영한다. 아직 stack이 확정되지 않은 신규 repo는 App을 추측 생성하지 않는다.

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
- 복구 DB로 production Backoffice server가 Ready가 되고 resolved manifest를 HTTP로 재생한다.
- 모든 ACTIVE snapshot 서명이 맞고 잘못된 키와 DRAFT는 기존 resolve 경계에서 거부된다.
- verifier는 SHA, count, digest와 성공 여부만 출력한다. production DB URL/password는 Pod에 주입하지 않는다.
- verifier 종료 시 MySQL을 내리고 Pod-scoped `emptyDir`을 폐기한다. Job은 감사용 metadata만 7일 보존한다.

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
