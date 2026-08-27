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
| `POST` | `/api/control-plane/discovery-observations` | 정확한 40자리 source SHA의 탐지 결과와 build target projection 기록 |
| `POST` | `/api/control-plane/provider-observations` | provider readback과 공개 external binding 기록 |
| `POST` | `/api/control-plane/config-revisions` | immutable `DRAFT` revision 생성 |
| `POST` | `/api/control-plane/config-revisions/activate` | `expectedActiveRevision` CAS로 `DRAFT → ACTIVE`, 이전 ACTIVE는 `SUPERSEDED` |
| `GET` | `/api/control-plane/apps/{repoId}/resolved-manifest?ref={sha}&market=&revision=` | exact SHA observation과 서명 검증된 config snapshot 조립 |
| `GET` | `/api/control-plane/reauth-requests?repoId=` | 앱 범위의 공개 reauth gate와 대기 상태 조회 |
| `POST` | `/api/control-plane/reauth-requests` | 비밀값 없이 `HUMAN_REAUTH_REQUIRED` append |
| `POST` | `/api/control-plane/reauth-requests/trusted-local-pending` | repo scope와 generation CAS로 trusted-local 처리 대기 기록 |
| `POST` | `/api/internal/agents/claim` | 최대 5분 lease와 generation capability 발급 |
| `POST` | `/api/internal/agents/heartbeat` | 현재 generation lease만 연장 |
| `POST` | `/api/internal/agents/complete` | 현재 generation을 성공 종료 |
| `POST` | `/api/internal/agents/fail` | attempt 한도 내 재큐잉, 초과 시 dead-letter |

Config payload는 생성 API 이후 수정 경로가 없다. activation snapshot은 canonical JSON의 SHA-256과
HMAC을 저장하며 resolved manifest가 이를 다시 검증한다. 서명 키가 없거나 값이 맞지 않으면
기존 ACTIVE snapshot도 제공하지 않는다.

Config payload는 UI와 internal API가 같은 validator와 service를 사용한다. 법적 선언, 계정 소유권,
결제·세금·은행·계약, 심사 제출, 공개 배포, credential 변경 필드는 별도 사람 승인 workflow가
구현되기 전까지 DRAFT 생성과 activation에서 모두 fail-closed한다. 이전 validator로 만들어진
DRAFT도 activation 시 다시 검사한다.

## 운영 UI와 재인증 경계

앱 워크스페이스의 `Fleet` 탭은 DiscoveryObservation, ACTIVE/DRAFT ConfigRevision,
ProviderObservation, PlatformFleetBinding, CredentialBinding, AgentRun/dead-letter와 ReauthRequest를
한 화면에서 조회한다. CredentialBinding에는 logical ID, 공개 account identity, fingerprint와 scope만
있으며 secret 값을 저장하거나 변경하는 endpoint는 없다.

ReauthRequest는 `HUMAN_REAUTH_REQUIRED → TRUSTED_LOCAL_PENDING`만 지원한다. 이는 사람이 별도의
trusted local UI에서 처리하기를 기다린다는 운영 기록이며 로그인 수행이나 성공 판정이 아니다.
Backoffice에는 비밀번호, TOTP, passkey, SMS/push 승인, cookie, recovery code 입력 UI가 없다.

## Queue 불변식

- claim은 `AgentRun.status`와 `leaseGeneration`을 같은 transaction에서 CAS한다.
- `AgentLease.scopeKey=repo-pr:{owner/repo}`의 nullable unique index로 repo별 자율 PR 실행을 하나로 제한한다.
- claim 직전에 현재 `IssueMirror`의 closed, `blocked`, `approval:*`, `no-autopilot` 상태와 기존 open autopilot PR을 다시 확인한다.
- token 원문은 저장하지 않는다. DB에는 SHA-256만 저장하고 같은 idempotency 요청의 token은 server-only HMAC으로 재생성한다.
- heartbeat와 settle은 worker ID, token hash, generation, TTL을 모두 대조한다. 이전 generation의 completion은 거부한다.
- 만료 lease는 scope를 해제하고 retry 또는 dead-letter로 수렴하며 모든 전이는 `AgentRunEvent`에 append한다.

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
