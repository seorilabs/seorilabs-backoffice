# Fleet automation 설치·운영 계약

## 현재 제공되는 것

- Backoffice routine template: 앱 Fleet 화면에서 Codex/Claude, 수동·매시간·매일 cadence, 1회 예산 상한, `READY_PR`/`READ_ONLY` 승인 정책을 선택한다.
- durable scheduler endpoint: `/api/admin/automation/schedule`이 누락 schedule, webhook inbox, 만료 lease를 재조정한다.
- generic worker contract: Codex와 Claude 각각 조직당 설치 상한 1개다.
- Platform Fleet internal template: 검증된 서명 manifest와 exact observation에서 만든 `PLATFORM_SDK_UPDATE` task만 Codex generic worker가 처리한다. 별도 앱 routine이나 Issue를 만들지 않는다.
- Source remediation internal template(`repo-source-remediation-v1`): `classification=PRODUCT_APP`이지만 discovery가 `NO_CANDIDATE`/`BUILD_TARGET_MISSING`으로 `NEEDS_INPUT`인 repository의 catch-22 전용 단발 routine이다. 앱 Fleet 화면의 일반 routine picker가 아니라 `/api/control-plane/source-remediation-definitions`로만 만들며, 나머지 template의 `RepositoryRegistration.status=MANAGED` guard는 전혀 건드리지 않는다. 자세한 조건은 `docs/FLEET_CONTROL_PLANE.md`의 "Source remediation" 절.
- Project projector: `Priority`, `App`, `Kind`, `Lifecycle`, `Agent`, `Approval`, `Outcome`을 desired/observed ledger로 분리하고 write 뒤 readback한다.
- WorkflowBundle candidate executor: signed ACTIVE config가 exact CANDIDATE record를 승인한 두 고정 canary repository에서만 중앙 generator caller 두 파일을 Ready PR로 만든다. 운영/활성화 gate는 [workflow-bundle-candidate-executor.md](./workflow-bundle-candidate-executor.md)를 따른다.

## 운영 상태와 worker gate

deterministic scheduler는 `k8s/scheduler-cronjobs.yaml`의 `backoffice-automation-scheduler`로 배포하며 매분 누락 schedule, webhook inbox, 만료 lease를 멱등 재조정한다. 코드·리뷰를 수행하는 generic worker는 다음을 확인한 뒤 각각 조직당 하나만 설치한다.

1. migration이 운영 DB에 적용되고 Backoffice 새 revision이 배포됐다.
2. `INTERNAL_ADMIN_TOKEN`, `CONTROL_PLANE_ADMIN_TOKEN`과 그 token에 결합된
   `CONTROL_PLANE_ADMIN_PRINCIPAL`, 서로 다른 `AGENT_WORKER_CODEX_TOKEN`과
   `AGENT_WORKER_CLAUDE_TOKEN`은 K8s mTLS `seori-auth` runtime만 보유한다.
   모델은 token이나 Authorization header를 만들지 않고 공개 `sessionId`만 전달한다.
   legacy `AGENT_WORKER_TOKEN`은 worker principal을 증명하지 못하므로 사용하지 않는다.
3. Codex와 Claude generic worker가 각각 0개 또는 1개인지 확인한다. 이미 있으면 새로 만들지 않고 업데이트한다.
4. 중앙 `FleetProjectBinding`에 조직 단일 `Seorilabs Fleet` owner/number를 revision으로 등록하고 GitHub App의
   `organization_projects:write` grant와 공개 node/title/URL을 readback한다. 권한이 없으면 Project를 absent로
   추측하지 않고 `HUMAN_PERMISSION_REQUIRED`로 둔다. 앱별 `projectV2Id` 입력은 없으며 projector는 Project나
   field/option을 생성하지 않는다.
5. canary 앱에서 claim 경쟁, TTL 재claim, 결과 불명 readback, repo PR guard를 검증한다.
6. generic worker에는 GitHub/provider write credential을 직접 주입하지 않는다.
   `READY_PR`은 worker와 다른 adapter identity, exact runtime identity, Ed25519 공개키 외에도
   `CREATE_COMMIT/CREATE_REF/CREATE_PR` durable step ledger는 구현됐다. 실제 GitHub canary와 runtime 승인 gate가
   코드에서 `false`이므로 credential과 `AGENT_TRUSTED_ADAPTER_DEPLOYED=true`를 설정해도 생성과 claim은 fail-closed한다.
   `k8s/seori-auth-agent-runtime.yaml`은 기본 `replicas: 0`이다. K8s 실행은 exact Codex/Claude SPIFFE SAN의
   TLS 1.3 mTLS만 허용한다. client certificate는 generic service-account SAN을 공유하지 않고
   `/instance/{unique-id}` SAN·fingerprint·serial digest를 session에 고정한다. Codex·Claude는 서로 다른
   OS UID/GID와 launchd job을 사용하고, worker client는 자기 UID/GID 소유 `0600` Unix socket만 호출한다.
   root relay가 native peer attestation 뒤 mTLS를 수행하며 worker는 certificate·private key·kubeconfig를 읽지 않는다.
   공개 요청은 `scripts-dist/seori-auth-agent-client.cjs` stdin으로 보내며 bearer, certificate, attestation을 argv나
   JSON에 넣지 않는다.
7. `platform-fleet-reconcile-v1` claim은 `issueNumber=null`, strict `taskInput`, 현재 repo source SHA 일치를 검증한다. exact SDK/vendor와 PR marker 외의 변경, Project field 기반 claim, 계약 feature 활성화·upload·실기기 QA·공개 rollout을 거부한다.

Codex와 Claude worker는 앱별로 설치하지 않는다. 기존 generic worker가 있으면 중복 생성하지 않고 같은 계약으로 업데이트한다.

## GitHub READY_PR runtime activation blocker

1. canonical credential catalog의 기존 logical identity를 `seori-auth-agent-*` projected Secret 실행 복제본에
   매핑하고 공개 App ID, adapter principal, Ed25519 public key fingerprint가 Backoffice 값과 같은지만 확인한다.
   이 단계에서 key를 생성·회전하거나 원문을 출력하지 않는다.
2. manifest를 immutable image digest로 render하고 `replicas: 0` 상태에서 server/client certificate SAN,
   Backoffice exact HTTPS origin, GitHub App installation 공개 ID를 readback한다.
3. fake repository에서 complete pagination, cross-principal 거부, repository ID 1개·최소 permission token과
   즉시 revoke, step별 readback-first partial-resume canary를 통과한다. Calico OSS의 표준 NetworkPolicy는 FQDN을
   제한하지 못하므로 runtime과 candidate executor는 `seori-auth-egress-proxy:8443`만 호출한다. proxy만 Internet 443을
   가지며 mTLS client SPIFFE ID마다 exact CONNECT hostname을 따로 결합하고 public DNS answer와 IANA special-purpose
   제외를 검증한다. redirect는 따르지 않으며 upstream TLS 검증은 client가 유지한다.
4. `CREATE_COMMIT`, `CREATE_REF`, `CREATE_PR`별 durable CAS/readback과 exact partial resume, 각 provider write 직후
   프로세스 종료 fixture는 구현됐다. lease 만료 뒤 새 `READBACK_FIRST` session은 `GITHUB_READY_PR_READBACK`으로
   서버가 선택한 기존 execution을 write 없이 확인하고, current-session readback audit 뒤 같은 execution의 최초 미완료
   step만 새 TTL로 재개한다. 실제 private repository canary에서 같은 증거를 확인한다.
5. 중앙 `.github` macOS agent relay의 exact source, native helper SHA-256, root-owned config와 worker별
   UID/GID·socket·certificate·고정 runtime 통신 경로가 일치하지 않으면 local transport를 활성화하지 않는다.
6. 실제 canary 별도 검토에서 runtime gate를 열고 runtime Ready와 서명 readback을 확인한 다음에만 Backoffice
   `AGENT_TRUSTED_ADAPTER_DEPLOYED`를 `true`로 배포한다. 현재 revision에서는 이 단계로 갈 수 없다.
