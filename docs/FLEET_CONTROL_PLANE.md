# Fleet Control Plane v1

이 문서는 기존 앱별 JSON consumer를 유지한 채 도입한 Fleet Control Plane의 운영 계약이다.
provider 실행 큐와 worker 경계는 구현되어 있지만 설치 manifest는 기본 `replicas: 0`이다. 아래 활성화
gate 전에는 provider 쓰기나 마켓 upload가 일어나지 않는다. 심사 제출, 공개 배포, credential 값
저장·조회 기능은 이 경계에 존재하지 않는다.

## 인증과 공통 헤더

- 제어면 API: `Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN`과
  `X-Seori-Principal: $CONTROL_PLANE_ADMIN_PRINCIPAL`
- Codex/Claude agent queue API의 bearer와 principal header는 K8s mTLS `seori-auth` runtime이 붙인다.
  모델은 Authorization header나 token을 받지 않고 공개 `sessionId`만 사용한다. 동일 OS UID에서
  Codex/Claude를 구분할 native peer attestor가 없어 local transport 코드와 runtime은 제공하지 않는다.
- 두 worker capability는 서로 다른 값이어야 한다. legacy `AGENT_WORKER_TOKEN`과
  agent queue의 `X-Admin-Token`은 인증에 사용하지 않으며, 새 capability가 없으면 fail-closed한다.
- 제어면 principal은 token과 1:1로 결합하며 임의 header 값이나 미설정 principal은 거부한다.
- 모든 mutation: 8자 이상의 `Idempotency-Key`
- Config activation과 resolved manifest: 전용 Secret `backoffice-control-plane-snapshot-signing`의 `CONTROL_PLANE_SNAPSHOT_SIGNING_KEY`
- WorkflowBundle v5 static readback: GitHub issuer 서명, audience `seorilabs-control-plane`, 숫자 org/repo ID,
  caller와 called reusable workflow exact SHA, event source SHA를 모두 검증한다. `CONTROL_PLANE_ADMIN_TOKEN`은
  이 경로의 대체 인증으로 허용하지 않는다.
- agent claim: worker에 노출하지 않는 `AGENT_LEASE_SIGNING_KEY`
- GitHub mutation adapter: worker와 다른 `AGENT_TRUSTED_ADAPTER_PRINCIPAL`/bearer, exact
  `AGENT_TRUSTED_ADAPTER_RUNTIME_IDENTITY` 및 Backoffice에 등록된 Ed25519 공개키. route/body/idempotency key를
  함께 서명하며 private key와
  attestation은 모델이나 Backoffice 응답에 노출하지 않는다.
- `k8s/seori-auth-agent-runtime.yaml`은 기본 `replicas: 0`이고 Backoffice의
  `AGENT_TRUSTED_ADAPTER_DEPLOYED=false`, 코드의 미구현 durable step-ledger gate와 함께 잠긴다.
  현재 revision에서는 환경변수를 바꿔도 `READY_PR`을 생성하거나 claim할 수 없다.

토큰 audience와 worker principal을 함께 결합하며, audit에는 principal, logical entity ID, digest와 공개 식별자만 남긴다.
payload·result에는 비밀번호, TOTP seed, cookie, API key, receipt 또는 개인 식별자를 넣지 않는다.

## API

| Method | Path | 계약 |
| --- | --- | --- |
| `POST` | `/api/control-plane/discovery-observations` | 정확한 40자리 source SHA의 탐지 결과, strict `workflowCaller`, build target projection 기록 |
| `POST` | `/api/control-plane/provider-observations` | provider readback과 공개 external binding 기록 |
| `POST` | `/api/control-plane/config-revisions` | `expectedLatestRevision` CAS와 server-selected latest exact discovery에 결합한 immutable `DRAFT` 생성 |
| `POST` | `/api/control-plane/config-revisions/rebase` | latest non-legacy `DRAFT/ACTIVE` payload를 바꾸지 않고 current discovery에 새 `DRAFT`로 재결합. activation 없음 |
| `POST` | `/api/control-plane/config-revisions/discovery-draft` | `mode=DRAFT_ONLY`에서 revision 0/no-import 또는 검토 불가 legacy DRAFT 대신 exact-SHA BuildTarget market만 새 `DRAFT`로 투영. legacy payload 복사와 activation 없음 |
| `GET/POST` | `/api/control-plane/desired-state-backfill` | 기존 ACTIVE 앱과 비보관 PRODUCT_APP에 결합된 PAUSED/DEPRECATED 앱의 분류·입력 필요 요약 조회 / config가 없으면 exact discovery market `DRAFT`, valid ACTIVE config의 source만 바뀌었으면 동일 payload의 새 revision을 원자적으로 자동 활성화 |
| `GET/POST` | `/api/control-plane/repository-classification-decisions` | `NEEDS_INPUT` 결정·후속 정책 교정 및 decision 없는 `MANAGED` 관측 확정 큐 / generation과 decision revision CAS로 사람·승인된 AI의 append-only 분류·product identity 기록 |
| `POST` | `/api/control-plane/config-revisions/activate` | `expectedActiveRevision` CAS로 `DRAFT → ACTIVE`, 이전 ACTIVE는 `SUPERSEDED` |
| `GET` | `/api/control-plane/apps/{repoId}/resolved-manifest?ref={sha}&market=&revision=` | exact SHA observation의 `workflowCaller`와 서명 검증된 config snapshot 조립 |
| `GET` | `/api/control-plane/apps/{repoId}/resolved-manifest?ref={bindingSha}&application_ref={eventSha}&schema=workflow-bundle-v5-static` | GitHub OIDC와 ACTIVE config가 승인한 WorkflowBundle SHA로 static runtime binding readback. main push는 두 SHA가 같고 same-repo PR은 OIDC merge SHA와 GitHub App이 읽은 exact base/head repository를 분리 결합. JS profile은 `js-static-checks-v1.yml`, Godot은 `godot-checks-v3.yml` exact called path와 일치해야 함 |
| `GET` | `/api/control-plane/apps/{repoId}/resolved-manifest?ref={mainSha}&event_ref={eventSha}&workflow_sha={bundleSha}&build_profile={profile}&schema=workflow-bundle-v5-build[-canary]` | private repo의 trusted self-hosted GitHub OIDC, exact caller/called workflow SHA, ACTIVE config SHA+payload digest, immutable bundle registry, exact-main discovery build binding을 모두 결합한 Android build-only readback. canary는 고정 Happy Farm/RN·Lizard Tycoon/Godot same-repo PR만 허용 |
| `POST` | `/api/control-plane/workflow-bundles` | exact successful `.github` candidate run/artifact 또는 기존 candidate와 canonical Ed25519 서명을 검증해 불변 `CANDIDATE`/`APPROVED` registry record를 멱등 import. secret/private signing key를 받거나 반환하지 않음 |
| `GET` | `/api/control-plane/apps/{repoId}/project-blueprint-plan?ref={sha}&revision=` | exact SHA와 ACTIVE revision의 GCP/Firebase/Workspace plan 및 readback 상태 계산. provider write 없음 |
| `POST` | `/api/control-plane/provider-executions` | exact repo/source/ACTIVE config/desired/public identity/credential generation에 결합된 readback, deterministic apply 또는 internal upload 실행을 durable queue에 등록 |
| `POST` | `/api/control-plane/release-candidates` | source SHA, ACTIVE config, market target, artifact checksum, WorkflowBundle SHA·digest, Platform version을 하나의 candidate로 고정 |
| `POST` | `/api/control-plane/release-gate-observations` | candidate에 결합된 독립 gate observation append |
| `GET` | `/api/control-plane/platform-releases` | 내부 producer가 검증·기록한 `FLEET_APPROVED` release 불변 원장을 조회 |
| `POST` | `/api/control-plane/platform-fleet/reconcile` | 현재 ACTIVE app 전체 cohort와 exact discovery/provider observation으로 repo별 plan을 한 번만 생성 |
| `GET` | `/api/control-plane/reauth-requests?repoId=` | 앱 범위의 공개 reauth gate와 대기 상태 조회 |
| `POST` | `/api/control-plane/reauth-requests` | 비밀값 없이 `HUMAN_REAUTH_REQUIRED` append |
| `POST` | `/api/internal/agents/claim` | 최대 5분 내부 lease에 결합된 공개 `sessionId` 발급. raw lease/grant 없음 |
| `POST` | `/api/internal/agents/heartbeat` | principal/session/run/generation/repo/issue/source 결합이 유효한 현재 session만 연장 |
| `POST` | `/api/internal/agents/complete` | 현재 generation을 성공 종료 |
| `POST` | `/api/internal/agents/fail` | attempt 한도 내 재큐잉, 초과 시 dead-letter |
| `POST` | `/api/internal/agents/readback-required` | 외부 mutation 결과 불명을 기록하고 같은 run guard를 유지 |
| `POST` | `/api/internal/agents/readback` | 같은 run을 재claim한 새 generation lease로 `RESUME`, `COMPLETE`, `BLOCKED` 판정 |
| `POST` | `/api/internal/agent-adapter/github-mutations/authorize` | trusted adapter의 60초 Ed25519 route/body attestation과 complete GitHub snapshot을 소비해 tokenless JIT execution 생성 |
| `POST` | `/api/internal/agent-adapter/github-mutations/recovery` | 새 `READBACK_FIRST` session을 retained repo guard와 기존 execution에 결합하고 worker 입력 없이 read-only 복구 대상을 선택 |
| `POST` | `/api/internal/agent-adapter/github-mutations/steps/claim` | execution의 다음 exact step을 CAS claim하고 `EXECUTE_ONCE`, `READBACK_THEN_EXECUTE`, `READBACK_ONLY`, `ALREADY_VERIFIED` disposition을 발급 |
| `POST` | `/api/internal/agent-adapter/github-mutations/steps/plan` | `CREATE_COMMIT`의 deterministic tree/commit SHA를 현재 attempt·generation에 한 번만 결합 |
| `POST` | `/api/internal/agent-adapter/github-mutations/steps/complete` | provider readback을 현재 step attempt에 결합해 `VERIFIED`, `NOT_APPLIED`, `RESULT_UNKNOWN`으로 정산 |
| `POST` | `/api/internal/agent-adapter/github-mutations/readback` | exact head ref/marker의 branch와 전체 PR 상태를 서명 readback해 `VERIFIED`, `NOT_APPLIED`, `RESULT_UNKNOWN` 기록 |
| `POST` | `/api/control-plane/automation-definitions` | agent, cadence, 예산 상한, 승인 정책이 고정된 routine 생성 |
| `POST` | `/api/control-plane/automation-definitions/{id}/commands` | 즉시 실행, pause/resume, run cancel/dead-letter retry |
| `POST` | `/api/admin/automation/schedule` | webhook inbox, 누락 schedule, 만료 lease, terminal PR guard 조정 |
| `POST` | `/api/admin/automation/project-projections` | Fleet Project desired를 적용하고 실제 field를 readback |
| `POST` | `/api/admin/automation/platform-fleet` | latest Platform Release/approval을 검증·record/reconcile한 뒤 기존 contract Issue/SDK PR plan을 readback-first로 drain |

Config payload는 생성 API 이후 수정 경로가 없다. activation snapshot은 canonical JSON의 SHA-256과
HMAC을 저장하며 resolved manifest가 이를 다시 검증한다. 서명 키가 없거나 값이 맞지 않으면
기존 ACTIVE snapshot도 제공하지 않는다.

세 DRAFT 생성 경로는 `MANAGED/PRODUCT_APP`, GitHub에 등록된 exact default branch/ref, current
`repository-discovery/v10`, `lastDefaultPushSha=lastReconciledSha=latest discovery SHA`를 같은
serializable transaction 안에서 다시 확인한다. source app/ref/SHA/payload digest가 어긋나거나
caller의 `expectedLatestRevision`이 현재 revision과 다르면 아무 revision과 audit도 만들지 않는다.
legacy shadow DRAFT는 일반 rebase할 수 없다. 별도 discovery projection은 ConfigRevision과 legacy import가
모두 0건이거나 append-only import/parity 증거가 있는 latest legacy DRAFT에만 허용된다. revision 0 경로는
`PAUSED/DEPRECATED` product inventory도 누락하지 않지만, exact current discovery와 BuildTarget만 사용한다.
수동 rebase와 discovery projection은 모두 `DRAFT_ONLY`이며 법적/provider/free-text/localization/asset/build
값을 추측하지 않는다. 아래 중앙 scheduler의 자동 활성화는 별도 source-only 계약으로 제한한다.

Android build-only 권한은 ConfigRevision의 `build.workflowBundleSha` 주장만으로 열리지 않는다.
같은 revision에 `build.workflowBundleDigest`를 `sha256:` 형식으로 고정하고, 별도 immutable registry에서
같은 source SHA와 payload digest의 exact GitHub candidate artifact 또는 APPROVED 서명 provenance를
readback해야 한다. repository discovery의 static `workingDirectory`와 Android `buildBindings`는 별도 사실이며,
Happy Farm의 static `apps/mobile`을 build root로 투영하지 않는다. build binding이 없거나 둘 이상이면
`BUILD_BINDING_OBSERVATION_MISSING`으로 중단한다.

APPROVED registry는 ConfigMap `backoffice-workflow-bundle-v5-trust`의
`trusted-approval-keys.json`에 있는 ACTIVE Ed25519 공개키와 canonical SPKI fingerprint를 사용한다.
logical signer는 `shared/workflow-bundle/approval-signing`이며 private key, raw signature payload 또는
secret export endpoint는 Backoffice에 두지 않는다. trust root가 없거나 revoke되면 기존 APPROVED readback도
fail-closed하며 CANDIDATE는 successful GitHub artifact identity로 별도 검증한다.

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

## Agent session과 GitHub JIT mutation 경계

agent queue의 `sessionId`는 공개 locator일 뿐 credential이 아니다. 실제 권한은 helper가 보유한 workload
identity와 client certificate의 instance SAN/fingerprint/serial digest, DB의 `runId`, generation, principal,
numeric repo ID/full name, issue number, exact source SHA, TTL을
모두 비교해 판정한다. heartbeat, complete, fail, readback 요청 JSON에는 lease/grant/action token 필드가 없으며
strict validator가 해당 필드와 호출자 supplied run/generation을 거부한다. TTL 만료, revoked session, 다른
principal, 같은 principal의 다른 client certificate 또는 stale generation completion은 CAS 전에 거부한다.

`READY_PR` write 권한과 repo singleton은 mutable `AgentRun.createsPr`가 아니라 managed definition의
`approvalPolicy`와 resume mode에서만 파생한다. GitHub adapter는 durable step ledger까지 구현했지만
실제 GitHub canary와 운영 replica 승인이 남아 있어 runtime activation은 계속 fail-closed다.

1. command의 numeric repo ID 하나와 `contents:write`, `issues:read`, `pull_requests:write`만 지정해
   operation-scoped GitHub installation token을 발급한다. token 응답의 repository/permission과 GitHub repo
   ID/full name readback이 정확해야 다음 단계로 가며, 성공·실패와 무관하게 작업 직후 token을 폐기한다.
2. GitHub App으로 exact repository/default SHA, issue state/label, open autopilot PR 전체를 페이지 끝까지 읽는다.
3. K8s client certificate의 exact `/instance/{unique-id}` SPIFFE SAN, fingerprint, serial에서 Codex/Claude
   principal과 session runtime binding을 얻는다. worker JSON의 principal
   주장은 받지 않는다. mode `0600`만으로 같은 UID 프로세스를 구분할 수 없어 local runtime은 fail-closed다.
4. 변경 파일 내용 자체는 보내지 않고 경로·mode·content SHA-256을 정규화한 `mutationIntentDigest`를 만든다.
   route/body/idempotency key/runtime/60초 TTL에 결합된 Ed25519 attestation을 보내며 Backoffice는 전역 1회 nonce를 소비한다.
5. Backoffice가 session principal, current registration/source, issue eligibility, repo guard와 intent digest를 다시 확인하고 token 원문이
   없는 action grant, mutation execution, `CREATE_COMMIT`/`CREATE_REF`/`CREATE_PR` step을 같은 transaction에서 만든다.
6. authorization은 write 권한이 아니라 `STEP_LEDGER` 진입점이다. 각 step은 별도 request id, generation CAS, 60초 이하 TTL,
   worker instance digest, adapter runtime identity에 결합된다. 만료된 attempt는 `STALE`로 닫고 다음 generation만 claim한다.
7. `CREATE_COMMIT`은 content-addressed tree를 만든 뒤 고정 author/committer/date로 expected commit SHA를 계산해 DB에 먼저
   `PLANNED`로 기록한다. 이후 commit, ref, PR 모두 provider readback에서 exact expected 상태가 없을 때만 한 번 쓰며,
   응답 유실 뒤에는 저장된 SHA/ref/marker를 먼저 조회해 완료된 단계를 건너뛴다.
8. step completion은 attempt ID와 generation이 current이고 TTL이 남아 있을 때만 수용한다. provider write 직후 프로세스를
   강제 종료하는 세 지점의 회귀 fixture가 각 write를 한 번만 수행함을 검증한다. 전체 target snapshot이 exact PR을 찾고
   세 step이 모두 `VERIFIED`일 때만 execution을 `VERIFIED`로 닫는다. 일부 step이 시작된 뒤 branch/PR이 없다는 관측은
   `NOT_APPLIED`가 아니라 `RESULT_UNKNOWN`이다.
9. 기존 session/grant가 만료되면 새 `READBACK_FIRST` session이 recovery route에서 동일 run/repo ID·이름/issue/source와
   retained repo guard를 다시 검증한다. adapter는 worker가 지정한 SHA/ref/marker를 받지 않고 기존 ledger를 읽어 각 step을
   `READBACK_ONLY`로 확인한다. current session의 `RESULT_UNKNOWN` readback과 `RESUME` audit가 남은 뒤에만 같은 execution의
   최초 미검증 step에 새 TTL을 부여하며, 이미 `VERIFIED`인 step과 원 grant는 변경하지 않는다.
10. `trustedGithubStepLedgerImplemented()`는 `true`지만 `trustedGithubRuntimeCanaryApproved()`와
   `READY_PR_RUNTIME_OPERATIONAL`은 `false`, runtime replica는 0이다. 따라서 설정값만 바꿔 운영 mutation을 열 수 없다.

모델이 호출하는 공개 경계는 `scripts-dist/seori-auth-agent-client.cjs`의 stdin JSON 하나다. K8s client는
projected client certificate로 TLS 1.3 mTLS만 사용한다. native peer attestor 또는 worker별 전용 OS UID/launchd
경계가 구현되기 전에는 local transport를 client와 runtime 양쪽에 두지 않는다. K8s runtime만
Backoffice worker bearer, adapter bearer, Ed25519 private key와 GitHub App private key 파일을 읽는다. 응답은
공개 `sessionId`, 실행 상태, PR number/URL만 통과하며 credential 후보 key/value가 있으면 전체 응답을 폐기한다.

사람 재인증, 심사 제출, 공개 배포, role/permission/key 변경은 이 action policy에 존재하지 않는다.

### READY_PR 활성화를 위한 남은 운영 gate

durable ledger와 partial-failure fixture는 구현됐다. 남은 범위는 fake repository가 아닌 실제 private canary에서
각 단계의 응답 유실·token revoke·재시작 readback을 증명하고, immutable runtime image와 제한 egress를 검증한 뒤
`trustedGithubRuntimeCanaryApproved()`, `READY_PR_RUNTIME_OPERATIONAL`, replica를 별도 승인으로 여는 일이다.
그 전에는 P6와 `READY_PR` 운영 activation을 완료로 표시하지 않는다.

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
`PROVIDER_SHELL=PASSED`는 일반 caller evidence만으로 기록할 수 없다. release candidate와 같은 transaction에서
exact app ID·source SHA·ACTIVE config revision의 ProjectBlueprint를 다시 계산해 `COMPLIANT`일 때만 기록하며,
Blueprint가 없으면 `BLUEPRINT_NOT_CONFIGURED`, readback·공용 provisioner가 미준수이면
`PROVIDER_SHELL_NOT_COMPLIANT`로 원장 변경 없이 거부한다. 저장 evidence의 app ID·project ID·source SHA·revision·
plan digest·exact provider observation ID는 서버가 계산하며 HTTP 요청 계약에는 이 provenance 필드가 없다.
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
profile은 `react-native | capacitor | ait-web | godot`이고 workingDirectory는 repository 상대 경로만 허용한다.
JS profile은 packageManager를 `npm | pnpm`으로 확정해야 하며, 자체 package manager 계약이 없는 Godot은
반드시 `null`이다. Capacitor는 `@capacitor/core`, AIT web은 `@apps-in-toss/web-framework` exact package fact로
탐지하며 여러 product 후보가 남으면 하나를 추측하지 않는다.
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
raw·정규화 manifest에는 영향 consumer 선택 계약
`cohort=backoffice-active-apps`, `resolution=reconcile-time`을 포함한다. 구체 repo ID 목록은 release 뒤에도
바뀌므로 immutable asset에 복사하지 않고 reconcile 시점의 current snapshot에서 확정한다. 따라서 앱
추가·중단이 release identity를 바꾸지 않으며, 매 reconcile은 현재 ACTIVE app 전부를 요구한다. 기존 공개
`v0.6.7` raw·normalized manifest에 선택 필드가 없을 때만 같은 단일 계약을 read-time에 투영한다. 저장된
manifest, digest, signature, idempotency identity는 바꾸지 않으며 `v0.6.6`, `v0.6.8+` 누락은 거부한다.
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
- PR 생성 권한 lease의 만료와 `RESULT_UNKNOWN`은 기존 lease를 폐기하고 run을 durable readback 대기로 전환한다. 다음 claim만 새 generation의 `READBACK_FIRST` capability를 발급한다. 이 session은 서버가 선택한 기존 execution에 대한 read-only recovery만 수행하며, 이전 token의 resolution과 새 mutation은 거부한다.
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
branch와 해당 default branch HEAD를 provider에서 다시 읽은 뒤 exact commit tree만 탐색한다. default push SHA와
현재 HEAD가 다르거나 탐지 중 HEAD가 움직이면 이전 run은 `STALE`로 닫고 current HEAD를 새 generation으로
enqueue한다. 만료 worker의 완료는 `leaseGeneration`과 registration generation CAS에서 거부된다.

탐지 파일은 verified tree에서 선택한 `package.json`, `project.godot`, native build identity,
canonical `export_presets.cfg` 또는 canonical이 없을 때의 `ci/export_presets.<target>.cfg` fragment,
`build.env`, `granite.config.ts`로 제한한다. 원문은 parser 호출 동안만 유지하며 DB에는
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
  public repository는 `NEEDS_INPUT`이다. default branch 이름은 `main`으로 강제하지 않고 GitHub numeric
  repository readback에서 확인한 정확한 branch/ref에 모든 source·config·runtime 증거를 결합한다. target은 exact source에 존재하지만 package ID, bundle ID,
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
  `PLATFORM_PRODUCER`로 관리하며 RN/Capacitor/AIT web/Godot App 후보에서 명시적으로 제외한다.
- default push와 repository lifecycle webhook은 공개 numeric repo identity, ref, SHA를 delivery와 같은
  transaction의 automation inbox에 checksum으로 봉인하고 기존 실행을 즉시 fail-closed한다. inbox 처리는
  GitHub의 현재 repository identity와 HEAD를 다시 읽어 오래되거나 순서가 뒤집힌 payload를 적용하지 않는다.
  scheduler는 GitHub redelivery에 의존하지 않고 FAILED/PENDING inbox를 재처리하며, 기존 ingress-only row도
  동일 payload 검증 뒤 delivery 원장과 멱등 복구한다.

worker replica는 RPI5에 1개, poll은 2초, lease는 90초이며 exact source file read 전에 갱신한다. 최대 시도는 3회다.
durable enqueue와 실행 차단은 webhook transaction에서 즉시 완료하고, provider readback 뒤 discovery run을
등록한다. 10분을 넘긴 non-terminal run은 `DISCOVERY_SLO_EXCEEDED`로 `NEEDS_INPUT` 종료한다. 따라서
신규 private RN/Capacitor/AIT web/Godot repo의 5분 등록/10분 bootstrap 또는 정확한 needs-input SLO를 DB의 createdAt,
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

## 중앙 desired-state DRAFT와 safe source rebase

hourly `backoffice-desired-state-backfill`은 기존 `App.status=ACTIVE` row에 더해 비보관
`RepositoryRegistration.classification=PRODUCT_APP`에 결합된 `PAUSED/DEPRECATED` App도 cohort로 고정한다.
repoId가 없는 기존 ACTIVE 앱도 제외하지 않고 `APP_REPO_ID_MISSING`으로 표시한다. exact current
`RepositoryRegistration.classification=PRODUCT_APP`, `DiscoveryObservation`, 같은 SHA의 BuildTarget이 모두
맞을 때만 확인된 market과 internal/private/TestFlight channel을 새 ConfigRevision `DRAFT`로 만든다.
registration과 run은 `repository-discovery/v10`을 함께 저장하므로 legacy terminal run은 hourly sweep에서
새 generation으로 재탐지되며 이름만 바꾼 분류로 간주되지 않는다.
ConfigRevision은 `sourceObservationId` FK와 backfill contract version을 보존하고 app row lock 아래 revision을
할당한다. 같은 observation의 동시 실행은 unique key와 stable idempotency key로 하나만 생성된다.

기존 ACTIVE가 latest discovery보다 오래된 경우에는 같은 transaction에서 MANAGED PRODUCT_APP 등록,
default-branch exact discovery, current-SHA BuildTarget을 다시 잠가 읽는다. 기존 ACTIVE snapshot의 HMAC,
revision identity, payload digest가 모두 유효하고 latest DRAFT를 포함한 desired payload 전체 digest와 enabled
market 집합이 그대로일 때만 source-only immutable revision을 만들고 `DRAFT → ACTIVE` CAS를 수행한다.
같은 source observation은 contract unique key와 deterministic activation key로 한 번만 처리한다. payload,
BuildTarget market, legacy DRAFT 또는 snapshot이 다르면 기존 DRAFT/ACTIVE를 변경하지 않고 `NEEDS_INPUT`으로
남긴다. audit에는 변경 0건과 source/revision 공개 identity만 기록하며 provider execution, 법적·결제·심사,
공개 승인 원장은 건드리지 않는다.

locale을 알 수 없으면 빈 목록으로 두며 localization 문구, ProjectBlueprint의 조직/folder/billing/project,
compliance, StoreAsset checksum은 source/provider evidence가 완전하지 않은 한 새로 만들지 않는다. 특히 법적
선언, 계정 소유권, 결제·세금, 심사 제출과 공개 배포 승인은 자동 생성하지 않는다. `/settings`는 repository classification,
DRAFT 가능/기존 설정/needs-input 수와 이유를 함께 표시한다. 같은 설정 화면과 internal API는 동일한 strict
validator와 transaction service를 사용한다. nullable expand column의 `classificationDecisionVersion=null`은
revision `0`으로만 해석하며 분류 결정은 이 revision CAS와 idempotency
key를 요구하고 이전 revision을 수정하지 않으며 audit에는 공개 repo/candidate identity만 남긴다.
이미 exact terminal discovery로 `MANAGED`인 repository에 decision revision이 없는 경우에는
`CURRENT_OBSERVATION_RATIFIED`만 허용한다. 요청 분류, 단일 product candidate marker, generation,
default push/reconciled/source SHA, discovery contract, candidate digest와 terminal observation을 모두
같은 transaction에서 재검증한 뒤 revision 1만 append한다. 이 경로는 registration의 관측 상태를 바꾸거나
discovery를 enqueue하지 않는다. 이후 분류 변경은 `CENTRAL_POLICY_CORRECTION` 새 revision으로만 기록하며
새 generation discovery를 enqueue한다. 따라서 ratification 오류는 row 삭제나 revision 되감기가 아니라
후속 교정 revision과 exact-source 재탐지로 복구한다.

`PRODUCT_APP` decision v2는 `displayName`, `type`, `engine`의 최소 product identity를 필수로
결합한다. 같은 strict validator와 transaction service를 사람 UI와 승인된 AI API가
공유하며, source candidate가 없는 docs-only repository도 App과 `FleetLifecycleState=PLANNING`으로
중앙 등록할 수 있다. 이 분류·identity는 desired state이므로 후속 source discovery가
`NO_CANDIDATE`, `BUILD_TARGET_MISSING` 또는 읽기 오류로 끝나더라도 `PRODUCT_APP`을
null로 되돌리지 않는다. 대신 `PRODUCT_SOURCE_CANDIDATE_MISSING`,
`PRODUCT_BUILD_TARGET_MISSING`, `PRODUCT_DISCOVERY_NOT_READY`로 구성·release·migration gate를
닫는다. observation, BuildTarget, market identity는 source/provider 증거 없이 생성하지 않는다.

배포 catch-up은 full-org discovery enqueue가 성공한 뒤 현재 generation의 provider readback이 terminal 상태가
될 때까지 drain한다. `FAILED`, 재enqueue 없이 남은 `STALE`, 누락 current run은 성공으로 숨기지 않는다.
두 번의 terminal readback 뒤에만 중앙 DRAFT backfill을 실행하며 세 단계 중 하나라도 실패하면 catch-up Job과
배포가 실패한다. `desired-state-safe-source-rebase/v3`부터 배포 Job은 렌더된 소문자 40자리 source SHA를
`x-seorilabs-source-sha`로 전달한다. 배포 occurrence key와 request hash는 이 SHA, 고정 actor,
`DEPLOY_CATCH_UP` trigger에 결합되므로 동일 SHA 재시도만 기존 run을 replay하고 같은 UTC hour의 다른 SHA는
새 run을 만든다. hourly Cron은 source SHA가 없는 별도 `HOURLY_CRON` occurrence key를 사용한다.
run은 공개 `trigger`, `sourceSha`, request hash를 보존하며 응답 header와 Pod termination message의
run ID, contract, source SHA, `COMPLETED`, `failed=0` readback이 모두 맞아야 배포가 성공한다. 응답 body와
admin token은 Job 또는 배포 로그에 남기지 않는다. 정기 scheduler 자체는 삭제하거나 suspend하지 않는다.

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

### 3. P7 38-repository BOOTSTRAP shadow readiness

기존 `fleet-parity-wave`는 ACTIVE 앱의 legacy config parity 원장이다. P7의 GitHub App 전체
repository collector와 같은 실행이 아니며, 그 결과를 38-repository BOOTSTRAP inventory로
재사용하지 않는다.

배포 이미지의 다음 command는 GitHub App installation pagination을 두 번 읽고, 각 active
repository의 numeric ID/default HEAD를 전후 재확인한 뒤 중앙 분류 결정과 App binding을 DB SELECT로만
검사한다. `PAUSED` 또는 `DEPRECATED` App도 numeric repo ID가 맞으면 존재하는 binding으로 읽되,
`PRODUCT_APP` repository에는 상태와 무관하게 ACTIVE config와 signed snapshot,
PlatformFleetBinding의 exact source 및 `COMPLIANT` 상태를 요구한다. non-product repository에 App row가
결합돼 있으면 lifecycle status와 무관하게 binding drift로 남긴다. GitHub와 DB에 쓰지 않고 공개 repo ID,
App lifecycle status, source SHA, digest, reason code만 출력한다.

```bash
kubectl -n platform exec deploy/backoffice -c backoffice -- \
  node /app/scripts-dist/fleet-migration-shadow-readiness.cjs
```

`state=READY`는 collector의 Backoffice 공개 증거 선행조건만 통과했다는 뜻이다. 실제 BOOTSTRAP
shadow는 중앙 `@seorilabs/repo-contract/fleet-migration-collector`에 다음 운영 adapter를 추가로
연결해야 한다.

1. GitHub App capability, complete pagination, HEAD/tree/BLOB GET adapter
2. legacy schema validator와 candidate replacement/proof public readback
3. durable collection occurrence claim/complete/read adapter
4. inventory public-key metadata readback과 secret-free Ed25519 signing service adapter

issuer가 authoritative inventory를 발급한 뒤에만 `createFleetMigrationPlan`을 실행한다. durable
state authority와 `trusted-cleanup-executor`는 승인된 cleanup PR 단계에서만 사용하며 두 번의
read-only shadow에는 claim이나 mutation을 만들지 않는다.
