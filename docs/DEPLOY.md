# 배포 런북 (vzyx-cluster / platform ns)

## 0. 사전
- 도메인 `backoffice.vzyx.xyz` → 클러스터 ingress (다른 `*.vzyx.xyz` 와 동일).
- 이미지 `registry.vzyx.xyz/seorilabs/seorilabs-backoffice`.

## 1. MySQL 전용 DB/User (data ns MySQL 재사용)
root 비밀번호는 `mysql-root-cred`(data ns).
```bash
ROOT_PW=$(kubectl -n data get secret mysql-root-cred -o jsonpath='{.data.password}' | base64 -d)
kubectl -n data exec -i deploy/mysql -- mysql -uroot -p"$ROOT_PW" <<'SQL'
CREATE DATABASE IF NOT EXISTS backoffice CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'backoffice'@'%' IDENTIFIED BY 'STRONG_PW_HERE';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES ON backoffice.* TO 'backoffice'@'%';
FLUSH PRIVILEGES;
SQL
```
> 호스트 `'%'`: pod IP 가 동적. 네트워크 격리는 NetworkPolicy 로 보완(후속).

## 2. GitHub App 생성 (신규 전용, seori-pr-bot 무관)
Org `seorilabs` → Settings → Developer settings → GitHub Apps → New.
- **Permissions(Repository)**: Metadata=Read, **Contents=Read & Write**, Pull requests=Read, **Actions=Read & Write**, Checks=Read, **Issues=Read & Write**.
  - `Actions=Read & Write`: 앱별 관리 도구가 저장소의 `.github/workflows/backoffice-ops.yml`을 dispatch할 때 필요하다.
  - `Contents=Read & Write`: 기존 출시 태그 생성 기능에 필요하다.
- **Subscribe to events**: Issues, Issue comment, Pull request, Push, Workflow run.
- **Webhook**: URL `https://backoffice.vzyx.xyz/api/webhooks`, Secret 신규 생성(= `GITHUB_WEBHOOK_SECRET`).
- **OAuth (로그인용)**: Callback URL `https://backoffice.vzyx.xyz/api/auth/callback/github` (+ 로컬 `http://localhost:3000/api/auth/callback/github`). "Request user authorization (OAuth) during installation" 체크.
- 생성 후: **App ID**(`GITHUB_APP_ID`), **Client ID**(`AUTH_GITHUB_ID`), Client secret 생성(`AUTH_GITHUB_SECRET`), Private key(.pem) 생성(`GITHUB_PRIVATE_KEY`).
- **Install** → org 의 앱/게임 레포 선택(또는 All).

## 3. 시크릿 / pull cred
```bash
# registry-pull-cred 를 apps → platform 복제 (1회)
kubectl get secret registry-pull-cred -n apps -o yaml \
  | sed 's/namespace: apps/namespace: platform/' | kubectl apply -n platform -f -

# broad backoffice-secrets (k8s/secret.example.yaml 첫 번째 문서 참고)
kubectl -n platform create secret generic backoffice-secrets \
  --from-literal=DATABASE_URL='mysql://backoffice:STRONG_PW_HERE@mysql.data.svc.cluster.local:3306/backoffice?connection_limit=5' \
  --from-literal=DB_PASSWORD='STRONG_PW_HERE' \
  --from-literal=AUTH_SECRET="$(openssl rand -base64 33)" \
  --from-literal=AUTH_GITHUB_ID='<client id>' \
  --from-literal=AUTH_GITHUB_SECRET='<client secret>' \
  --from-literal=GITHUB_APP_ID='<app id>' \
  --from-file=GITHUB_PRIVATE_KEY=./backoffice-app.private-key.pem \
  --from-literal=GITHUB_WEBHOOK_SECRET='<webhook secret>' \
  --from-literal=INTERNAL_ADMIN_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=GEMINI_API_KEY=''
```

## 4. 이미지 빌드 & 배포
CI(`.github/workflows/deploy.yml`)가 push main 시 빌드/푸시/롤아웃. 필요 GitHub secrets:
- `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` (registry.vzyx.xyz push)
- `KUBECONFIG_B64` (platform ns deployment patch 권한 SA kubeconfig, base64)

수동 최초 배포:
```bash
# stateful infrastructure는 CI deployer 권한 밖에서 한 번 만들고 Bound를 확인한다.
kubectl apply -f k8s/backup-pvc.yaml
kubectl -n platform wait --for=jsonpath='{.status.phase}'=Bound \
  pvc/backoffice-backup --timeout=120s

IMAGE='registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:<64자리-digest>'
SOURCE_SHA='<40자리-git-sha>'
BACKOFFICE_IMAGE="$IMAGE" BACKOFFICE_SOURCE_SHA="$SOURCE_SHA" \
  scripts/deploy-backoffice.sh
# 첫 component=web Pod 전환이 끝난 뒤 Service selector를 좁힌다.
kubectl apply -f k8s/backoffice-networking.yaml
```
`backup-cronjob.yaml`은 CI가 갱신하지만 PVC는 갱신하지 않는다. 백업 Job은 비밀번호를
전용 Secret volume에서 `mysqldump` child에만 전달하고, gzip·SHA-256 검증 뒤 dump 파일을
마지막에 완성본 이름으로 이동한다. production `backoffice` principal에는 의도적으로 `TRIGGER`
권한이 없으므로 `--skip-triggers`를 명시한다. app user 권한을 넓히지 않고 restore rehearsal이 exact
source 계약을 Pod-scoped MySQL에만 재구성한다. 이미 exact trigger 두 개가 있으면 보존하지만 부분·변형·
추가 trigger는 복구하지 않고 실패한다.
`CREATE TRIGGER`는 MySQL prepared statement에서 지원되지 않으므로 Prisma `$executeRawUnsafe`로
실행하지 않는다. verifier는 trigger가 정확히 0개일 때만 repo-local canonical DDL을
`prisma db execute --stdin`의 전용 child process에 전달한다. 격리 DB URL은 argv나 로그에 넣지 않고
그 child의 환경에만 주입하며 core dump를 비활성화한다. MySQL 9.2 통합 계약은 실제 trigger 두 개를
제거한 뒤 이 text-protocol 경로로 정확히 두 개가 재구성되는지 확인한다.
백업 복구 증명은 운영 DB에 restore하지 않고 `docs/FLEET_CONTROL_PLANE.md`의
`run-restore-rehearsal.sh`로 별도 수행한다. 이 Job에는 production DATABASE_URL과 DB password를
주입하지 않으며, Pod 내부 MySQL 9.2가 종료된 뒤에만 성공한다. 실패한 Job은 30분 timeout을 기다리지
않고 terminal condition에서 즉시 반환한다.
CI는 build가 반환한 immutable registry digest의 migration Job으로 `prisma migrate deploy`를
먼저 완료하고 source SHA를 별도 label로 기록한다.
실패하면 기존 Ready 웹과 worker/CronJob은 바꾸지 않는다. 완료 Job은 7일간 남아
실행 SHA와 결과를 감사할 수 있고, 웹은 `maxUnavailable: 0`, `maxSurge: 1`로 교체된다.
같은 SHA workflow를 재실행해 tag digest가 달라져도 digest가 Deployment template에 직접
반영되므로 migration과 기존 Pod가 서로 다른 artifact를 실행하지 않는다.

신규 migration은 `scripts/check-migration-safety.sh`의 expand-only gate를 통과해야 한다.
DROP/RENAME/MODIFY/데이터 삭제와 기존 writer를 깨는 NOT NULL column 추가는 한 번의
pre-deploy migration으로 허용하지 않고 expand → backfill → contract 단계와 별도 승인을 쓴다.
Job 실패 로그는 credential 노출 방지를 위해 CI에 출력하지 않는다.

### Provider audit trigger 부분 적용 복구

`20260828230000_provider_execution_queue`가 MySQL error 1419에서 멈췄고 두 provider
execution 표와 다섯 credential metadata column은 생성됐지만 audit trigger만 없다면,
일반 배포를 반복하지 않는다. 먼저 DB backup Job의 성공을 확인한다. 그 다음 trusted
operator가 같은 source SHA로 `provider-audit-trigger-recovery-job.yaml`을 render해 `data`
namespace에서 실행하고, exact trigger 두 개가 검증된 성공 Job만 증거로 사용한다. 이 Job은
`SUPER`, `GRANT TRIGGER`, `log_bin_trust_function_creators` 변경 없이 root secret을 전용
volume에서 읽어 두 DDL만 수행한다.

그 성공 뒤 같은 immutable Backoffice image로 `provider-migration-resolve-job.yaml`을
`platform` namespace에서 실행한다. Job은 새 recovery-state verifier로 이미 성공한 원장을
먼저 확인해 결과 유실 재실행이면 resolve 없이 deploy/status만 검증한다. 최초 복구는 preflight가
정확히 `미해결 migration attempt가 있다: 20260828230000_provider_execution_queue`로 실패한
단일 상태에서만 현재 schema diff를 확인하고 migration 하나를 `--applied`로 종결한다.
두 Job 중 하나라도 실패하거나 audit event가 이미 있는데 trigger가 없으면 배포를
중단하고 수동으로 migration history를 삭제하거나 table을 drop하지 않는다.

### 감사 원장 append-only trigger 배포 gate

`prisma migrate deploy` 뒤의 `verify-migration-state.cjs --history=fresh|cutover`는 schema
fingerprint에 더해 live DB의 append-only trigger를 다시 읽는다. baseline이나 recovery resolve로
migration row만 성공 처리돼 실제 trigger가 없으면 fingerprint는 통과하지만 이 readback이
fail-closed한다. 계약은 `src/lib/control-plane/append-only-triggers.ts`이며 migration SQL 선언과
같아야 한다. 보호 table에 계약 밖 trigger가 추가돼도 실패한다. 성공 로그의
`appendOnlyTriggers=<n>`이 검증된 trigger 수다.

MySQL은 대상 table의 `TRIGGER` 권한이 없는 principal에게 `information_schema.TRIGGERS`를 빈
결과로 돌려준다. 그래서 app verifier는 관측 전에 `SHOW GRANTS FOR CURRENT_USER()`로 가시성을 먼저
판정하고 권한 부족을 리소스 부재로 읽지 않는다. production migration principal
`backoffice`@`%`에는 `TRIGGER` 권한이 없으므로 로그는 `appendOnlyTriggers=FORBIDDEN(...)`이 된다.
app user에 `TRIGGER` 권한을 주지 않는다.

가시성이 없다고 검증을 건너뛰지는 않는다. 검증은 고정 in-cluster verifier가 맡는다.

`k8s/provider-audit-trigger-verifier.yaml`은 `data` namespace의 CronJob과 전용 ServiceAccount,
결과 ConfigMap `backoffice-provider-audit-trigger-state`, NetworkPolicy를 정의한다.

secret 유출 경계는 코드가 아니라 pod 구조로 강제한다. pod는
`automountServiceAccountToken: false`이고 컨테이너가 둘로 나뉜다.

- init container `verify` — `mysql-root-cred`만 mount한다. API server token이 없다. 두 trigger의
  이름, timing, event, table, action statement를 SELECT로만 확인하고 보호 table 위 trigger 총
  개수가 2인지도 본다. 임시 client 설정 파일은 trap으로 지운다. 결과는 공개 값만 담은 status
  파일로 emptyDir에 쓴다.
- container `publish` — projected KSA token과 공개 status 파일만 mount한다. DB secret이 없다.
  허용된 다섯 field만 읽고 각 값의 형식을 다시 강제한 뒤 ConfigMap을 patch한다. 동적 실행 없이
  key별 literal assignment만 하므로 관측 값이 shell command로 실행되지 않는다.

따라서 root secret을 보는 컨테이너에는 외부로 쓸 수단이 없고, 쓸 수단이 있는 컨테이너에는 root
secret이 없다. 두 이미지는 immutable digest로 고정하며 pod는 `seccompProfile: RuntimeDefault`를
쓴다. egress는 NetworkPolicy로 MySQL 3306과 API server의 고정 Service IP 443 및 MicroK8S
control-plane endpoint 16443만 허용한다. Calico가 Service DNAT 전후 어느 주소에서 정책을
판정하더라도 같은 API server 외에는 열리지 않는다. DNS는 열지 않고 kubelet이 주입한
`MYSQL_SERVICE_HOST`와 `KUBERNETES_SERVICE_HOST`로 접속한다. publisher의 API 요청은 connect/max
timeout으로 Job deadline보다 먼저 실패한다. Job의 4분 deadline은 스케줄 Pending 시간을
포함하되 다음 5분 주기 전에는 끝나도록 제한한다. verifier는 DDL, `GRANT`,
복구, 데이터 변경을 하지 않는다. 관측 결과는 `status`, `total`, `exact`, `contractDigest`,
`observedAt`만 남기며 비밀값이나 provider 오류 원문을 담지 않는다.

`scripts/deploy-backoffice.sh`는 app migration 직후, rollout 이전에 이 ConfigMap을 **읽기만**
한다. `status=PASS`, `total=2`, `exact=2`, repo 계약과 같은 `contractDigest`, 그리고 `observedAt`이
이번 배포 migration Job의 `status.completionTime`보다 **엄격히 이후**일 때만 rollout한다. 벽시계
max age가 아니라 migration 경계로 판정하므로 migration 이전 상태를 근거로 rollout하지 않으며,
같은 초 race도 거부한다. 완료 시각을 읽지 못하거나 ConfigMap이 없으면 배포를 중단한다.

CI deployer에는 `data` namespace의 workload mutation 권한을 일절 주지 않는다. Job·Pod 생성은
물론 CronJob `patch`/`update`도 금지한다. RBAC는 pod template의 field를 제한할 수 없어, CronJob을
고칠 수 있으면 Pod template에 `mysql-root-cred` 같은 임의 Secret volume을 붙일 수 있고 그 자체가
root secret export 경로다. `data` namespace의 CI 권한은 `vault-indexer`/`vault-writer` CronJob과
관측 ConfigMap에 대한 `get`뿐이다. `scripts/check-ci-deployer-permissions.sh`가 이 경계를 live로
확인한다. deploy job이 `KUBECONFIG_B64`를 설치한 직후, 배포 전에 실행한다. checker는 먼저
`kubectl auth whoami`로 identity가 정확히 `system:serviceaccount:platform:ci-deployer`인지 보고,
`resourceNames` Role이므로 정확한 리소스 이름(`configmap/backoffice-provider-audit-trigger-state`,
`cronjob/vault-indexer`, `cronjob/vault-writer`)으로 read 허용을 확인한다.

거부 쪽은 `can-i`만으로 증명할 수 없다. 이름 없는 질문은 다른 `resourceNames` 권한이 남아 있어도
`no`를 돌려주기 때문이다. 그래서 현재 identity의 `data` namespace 전체 규칙을
`SelfSubjectRulesReview`로 읽어 `secrets`+`get`/`list`/`watch`와
`pods`/`jobs`/`cronjobs`/`deployments`+`create`/`patch`/`update`/`delete`/`deletecollection` 조합이
하나라도 있으면 fail-closed한다. wildcard(`*`) group·resource·verb도 같은 조합으로 친다. 권한
목록이 불완전(`status.incomplete=true`)하면 부재를 증명할 수 없으므로 실패한다. 이 review는
read-only이며 지속 리소스를 만들지 않는다. kubectl의 client-side schema 검증은 권한과 무관한
CRD 목록 조회를 요구하므로 built-in review endpoint 제출에는 `--validate=false`를 사용하고,
응답 계약은 server-side `status` 파싱으로 검증한다. 이름을 지정한 `can-i` 거부 검증은 exact 경로 회귀를
잡는 보조 검증으로 함께 유지한다. impersonation(`--as`)은 ci-deployer에 권한이 없어 쓰지 않으며,
클러스터 접근 불가와 identity 불일치는 skip이 아니라 실패다. PR CI에는 kubeconfig가 없으므로
static 계약 테스트 `check-ci-deployer-permissions.test.sh`만 돈다.

그래서 Vault 이미지 parity는 CI가 고치지 않고 관측만 한다. deploy 로그의
`vault_image_parity=MATCH|DRIFT|ABSENT|UNREADABLE`이 그 결과다. `MATCH`와 `ABSENT`가 아니면
배포를 막지 않고 trusted operator 조치 명령을 함께 남긴다. 실제 갱신은 operator가
`kubectl apply -f <(scripts/render-manifest.sh k8s/vault-rag.yaml <image> <sha>)`로 수행한다.

verifier workload도 trusted operator가 직접 apply하며 deploy script는 apply하지 않는다.

계약이 바뀌면 operator가 verifier를 다시 apply해야 한다. 그전까지는 `contractDigest` 불일치로
배포가 fail-closed한다. 복구가 필요하면 위 trusted operator 복구 Job을 사람이 실행한다.
자동 실행하지 않는다.

### Provider execution signer 활성화

`k8s/provider-execution-worker.yaml`은 signer와 worker를 모두 기본 `replicas: 0`으로 둔다.
signer에만 DB URL, queue HMAC key, broker mTLS client key, Ed25519 attestation private key를
mount한다. worker에는 signer mTLS client identity만 주며 DB/broker/attestation volume과
MySQL/Auth Broker network egress가 없다. `provider-execution-signer-{server,client}`와
`provider-execution-signer-broker-client` 인증서는 각각 exact SPIFFE/DNS SAN을 검증한 실행
복제본이어야 하고, broker client는 signer ServiceAccount identity만 사용한다. 이 logical credential의 생성·동기화,
실제 P2 public key readback과 두 Deployment 활성화는 credential backup/restore와 fake-provider
canary를 통과한 별도 운영 gate다. key 값은 manifest, argv, 환경변수, 로그에 넣지 않는다.

## 5. 시드 + 검증
```bash
# 레지스트리 시드 헤드리스 실행. token을 셸로 꺼내지 않는다.
kubectl -n platform create job \
  --from=cronjob/backoffice-registry-seed \
  backoffice-registry-seed-manual-<고유번호>
# 또는 로그인 후 /settings 의 "레지스트리 시드/재스캔"
```
검증:
- `https://backoffice.vzyx.xyz/login` TLS valid → GitHub 로그인(allowlist).
- `/board`, `/issues`, `/releases` 에 시드 데이터 표시.
- GitHub App > Advanced > Recent Deliveries → Redeliver 로 webhook 200 확인.
- 보드 드래그 전이 → 새로고침 후 유지. deploy workflow_run 성공 시 출시 자동전이.

## 6. 운영 메모
- 라이프사이클 상태는 GitHub 에 없음 → `backoffice-db-backup` CronJob(일 1회) 유지. 복구 시 dump restore 후 reconcile.
- full-org repository discovery, 중앙 desired-state DRAFT backfill, reconcile, Xcode Cloud sync, registry seed,
  Platform Fleet 및 Fleet Project projection은 `scheduler-cronjobs.yaml`이 각각
  `concurrencyPolicy: Forbid`로 실행한다. 배포는 웹과 worker 전환 뒤 CronJob desired state를
  먼저 적용하고, 그 다음 별도 catch-up 대상 작업을 직렬 실행한다. catch-up의 중앙 설정 경로는
  repository discovery enqueue → 현재 generation provider readback drain → desired-state DRAFT 순서이며
  앞 단계가 실패하거나 timeout이면 뒤 단계를 실행하지 않는다. 배포 runner나
  catch-up이 실패해도 정기 scheduler를 delete 또는 suspend하지 않는다. 같은 시각 실행은
  endpoint의 durable idempotency/CAS로 한 번만 반영되고, 보존된 Job은 TTL로 정리된다. desired-state
  catch-up은 exact source SHA에 결합된 `DEPLOY_CATCH_UP` run을 만들며, 동일 SHA만 replay한다. hourly Cron은
  source SHA가 없는 `HOURLY_CRON` occurrence라 배포와 충돌하지 않는다. 배포 스크립트는 응답 body를
  출력하지 않고 Job termination message의 공개 run ID, contract, source SHA, `COMPLETED`, `failed=0`을
  다시 읽어 모두 일치할 때만 성공한다. 웹
  프로세스 안에는 scheduler가 없다. 내부 admin token은 Secret volume에서 읽어 curl config
  stdin으로 전달하며 환경변수나 argv에 넣지 않는다.
- Gemini Stage Agent는 `FEATURE_GEMINI_ENABLED=true` + `GEMINI_API_KEY`(§9).

## 7. CI 자동배포 설정 (main push → 검증/빌드/배포)

`ci.yml` 은 PR에서 정적 검증과 Next build를 완료한다. `deploy.yml` 은 push main 시
Next build를 제외한 정적 게이트를 다시 확인한 뒤, `-dind` 러너에서 production 이미지를
한 번만 빌드/push하고 build output digest를 `-arm64` 배포에 넘긴다.
`verify → build → deploy` 의존성으로 검증 실패 commit은 이미지 빌드나 배포를 시작하지 않는다.
deploy는 exact-digest migration Job 성공 → 웹 RollingUpdate → worker → scheduler CronJob →
catch-up 순서로 진행하며 각 workload의 digest를 다시 읽는다. 아래 3개를 1회 셋업한다.

**러너 배치**: **모든 잡이 GitHub-hosted(`ubuntu-latest`)에서 돈다. self-hosted(ARC)를
쓰지 않는다.** 이 저장소는 public 이고, org 러너그룹 "RPI ARM64 Builders" 의
**"Allow public repositories" 는 해제 상태로 유지한다.**

> 그 플래그는 저장소가 아니라 **그룹 단위**다. 켜면 그룹 access list 의 모든 public
> 저장소가 ARC 를 쓸 수 있게 된다. 그리고 `pull_request` 이벤트는 **fork 의 워크플로
> 파일로 실행**되므로(`pull_request_target` 이 따로 있는 이유), 외부인이 그 저장소 중
> 하나에 `runs-on: seorilabs-rpi-arm64` 워크플로를 담은 PR 을 열면 그 코드가 클러스터
> 안에서 돈다. 이 저장소 하나를 위해 org 전체 백스톱을 내리지 않는다.

배포가 hosted 에서 가능한 이유는 **k8s API 가 공개 도달 가능**하기 때문이다 —
`k8s.vzyx.xyz:16443` 은 공개 DNS 로 해석되고 kubeconfig 에 CA 가 들어 있다. 이미지도
클러스터 자원 없이 크로스빌드한다(§10). **어떤 잡도 ARC 로 되돌리지 않는다.**

> `ci-deployer` 최소권한 Role 은 실제 경계다. 과거 `AlwaysAllow` 인가 문제는
> [조직 P0 #45](https://github.com/seorilabs/.github/issues/45) 에서 `Node,RBAC` 전환으로
> 종료됐다. 회귀 확인: `kubectl auth can-i get secrets -n platform
> --as=system:serviceaccount:platform:ci-deployer` 가 `no` 여야 한다.

**(a) 배포용 SA + kubeconfig**
```bash
kubectl apply -f k8s/ci-deployer-rbac.yaml
kubectl apply -f k8s/ci-deployer-data-rbac.yaml

# server 는 GitHub-hosted 러너에서 닿아야 하므로 공개 엔드포인트여야 한다
# (k8s.vzyx.xyz:16443). LAN 주소가 잡히면 그대로 쓰지 말고 공개 호스트로 바꾼다.
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
TOKEN=$(kubectl -n platform create token ci-deployer --duration=8760h)
cat > /tmp/ci.kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters:
- name: vzyx
  cluster:
    server: ${SERVER}
    certificate-authority-data: ${CA}
users:
- name: ci-deployer
  user:
    token: ${TOKEN}
contexts:
- name: ci
  context: {cluster: vzyx, user: ci-deployer, namespace: platform}
current-context: ci
EOF
# CA 가 비면(예: insecure 설정) 위 certificate-authority-data 줄 대신 'insecure-skip-tls-verify: true' 사용.
```

**(b) GitHub repo secrets**
```bash
R=seorilabs/seorilabs-backoffice
gh secret set REGISTRY_USERNAME -R $R          # registry.vzyx.xyz push 계정
gh secret set REGISTRY_PASSWORD -R $R
base64 -i /tmp/ci.kubeconfig | gh secret set KUBECONFIG_B64 -R $R
rm -f /tmp/ci.kubeconfig
```

**(c) ARC 러너 그룹 — 불필요**
이 저장소는 self-hosted 러너를 쓰지 않는다. "RPI ARM64 Builders" 그룹에 등록하거나
"Allow public repositories" 를 켤 필요가 없고, **켜서도 안 된다**(위 §7 러너 배치 참고).

이후: main push → 자동 배포. 수동 재배포는 Actions → **Deploy** → Run workflow.

## 8. Sealed Secrets (시크릿 git 버전관리)

일반 Backoffice credential은 **암호화된 채 git에 보관**된다(`k8s/backoffice-sealedsecret.yaml`).
ACTIVE ConfigRevision snapshot HMAC 키는 blast radius를 줄이기 위해 exact key 하나만 가진
`backoffice-control-plane-snapshot-signing`으로 분리하고,
`k8s/control-plane-snapshot-signing-sealedsecret.yaml`만 이 Secret을 관리한다. web Deployment와
restore rehearsal은 전용 Secret만 참조하며 broad `backoffice-secrets`에는 이 key가 없어야 한다.
kube-system의 `sealed-secrets-controller`(v0.38.1)가 두 SealedSecret을 각각 복호화한다.

- **봉인 키 백업(필수·DR)**: `~/.config/seorilabs/sealed-secrets-master.key.yaml` — 이 키가 없으면 클러스터/컨트롤러 유실 시 SealedSecret 복호화 불가. **반드시 오프머신 안전 보관**. git 커밋 금지.
- **일반 시크릿 추가/회전**: 임시 평문 Secret 을 만들고 봉인 → 재커밋.
  ```bash
  kubectl -n platform create secret generic backoffice-secrets \
    --from-literal=KEY=VALUE ... --dry-run=client -o yaml \
    | kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller --format yaml \
    > k8s/backoffice-sealedsecret.yaml
  kubectl apply -f k8s/backoffice-sealedsecret.yaml   # 컨트롤러가 Secret 갱신
  ```
  (기존 Secret 이 SealedSecret 소유가 아니면 한 번 `kubectl -n platform delete secret backoffice-secrets` 후 재적용해 소유권 이관.)
- **snapshot signing key 추가/회전**: canonical catalog의 동일 logical credential을 전용 Secret 이름과
  namespace에 다시 봉인한다. broad SealedSecret ciphertext를 복사하거나 두 Secret에 같은 key를 동시에
  남기지 않는다. PR merge만으로 live Secret을 적용하지 않는다.
- **분리 rollout**: 별도 운영 승인 뒤 전용 SealedSecret을 먼저 적용하고
  `kubectl -n platform describe secret backoffice-control-plane-snapshot-signing`으로 key 이름과 byte 수만
  확인한다. `.data`와 평문을 출력하지 않는다. 그 다음 web Deployment를 적용하고 snapshot activation과
  resolved-manifest 서명 검증을 readback한다. restore rehearsal은 같은 전용 Secret이 확인된 뒤 실행한다.
- **DR 복구**: 새 컨트롤러 설치 → 백업한 master key 적용(`kubectl apply -f sealed-secrets-master.key.yaml` 후 컨트롤러 재시작) →
  `k8s/backoffice-sealedsecret.yaml`과 `k8s/control-plane-snapshot-signing-sealedsecret.yaml`을 각각 적용한다.

Discord 운영 알림은 단일 Bot과 목적지별 channel ID를 사용한다. Bot token과
Platform HMAC 원본은 `~/.config/seorilabs` 카탈로그에서 관리하고, 클러스터에는
아래 이름의 실행 복제본만 봉인한다. 값 원문을 문서·로그·PR에 남기지 않는다.

| Secret key | 용도 |
| --- | --- |
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` | Interaction 검증과 Bot 전송 |
| `DISCORD_CHANNEL_METRICS_DAILY_ID` | `#metrics-daily` |
| `DISCORD_CHANNEL_ACTION_EVENTS_ID` | `#action-events` |
| `DISCORD_CHANNEL_RELEASE_OPS_ID` | `#release-ops` |
| `DISCORD_CHANNEL_OPS_ALERTS_ID` | `#ops-alerts` |
| `DISCORD_CHANNEL_USER_REVIEWS_ID` | `#user-reviews` |
| `PLATFORM_EVENT_SHARED_SECRET` | Platform HMAC 검증 |
| `CONTROL_PLANE_ADMIN_TOKEN` | 제어면 observation/config/manifest API 전용 Bearer token |
| `CONTROL_PLANE_ADMIN_PRINCIPAL` | 위 token과 1:1로 결합되는 공개 workload identity. 기본 배포값은 `backoffice:fleet-operator` |
| `AGENT_WORKER_CODEX_TOKEN` | Codex generic worker principal에만 결합된 agent queue Bearer capability |
| `AGENT_WORKER_CLAUDE_TOKEN` | Claude generic worker principal에만 결합된 agent queue Bearer capability. Codex 값과 같으면 두 worker 모두 fail-closed |
| `AGENT_TRUSTED_ADAPTER_PRINCIPAL` | worker principal과 달라야 하는 seori-auth GitHub mutation adapter 공개 identity |
| `AGENT_TRUSTED_ADAPTER_RUNTIME_IDENTITY` | attestation에 허용할 exact workload runtime identity. 서명자가 임의 runtime 문자열을 주장하지 못하게 고정 |
| `AGENT_TRUSTED_ADAPTER_DEPLOYED` | durable `CREATE_COMMIT/CREATE_REF/CREATE_PR` step ledger와 실제 GitHub canary 뒤에만 `true`. ledger는 구현됐지만 runtime canary gate가 닫혀 있어 값을 바꿔도 `READY_PR` 생성/claim은 fail-closed |
| `AGENT_TRUSTED_ADAPTER_TOKEN` | 위 adapter에만 결합된 bearer. worker/모델에 주입하지 않으며 worker token 재사용 시 fail-closed |
| `AGENT_TRUSTED_ADAPTER_PUBLIC_KEY` | route/body/idempotency key/runtime/60초 TTL attestation 검증용 Ed25519 공개키. private key는 adapter에만 둠 |
| `CONTROL_PLANE_SNAPSHOT_SIGNING_KEY` | 전용 `backoffice-control-plane-snapshot-signing`에서만 공급하는 ACTIVE ConfigRevision snapshot HMAC 서명. 미설정 시 activation 거부 |
| `CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_ID` | snapshot signer의 공개 logical key ID. runtime manifest가 raw HMAC 대신 이 ID와 signature digest만 반환 |
| `CONTROL_PLANE_SNAPSHOT_SIGNATURE_POLICY_REVISION` | snapshot 서명 정책의 공개 revision. key ID와 함께 없으면 v5 runtime readback 거부 |
| `WORKFLOW_BUNDLE_V5_APPROVAL_PUBLIC_KEYS_JSON` | `backoffice-workflow-bundle-v5-trust/trusted-approval-keys.json`에서 공급하는 공개 Ed25519 key ID·policy revision·canonical SPKI fingerprint registry. 누락/폐기/불일치 시 APPROVED bundle import와 runtime readback 거부 |

역할 ID는 비밀값이 아니며 허용된 역할 mention과 명령 권한 검사에만 사용한다.
Bot이 보낸 일반 알림과 완료된 명령 메시지는 `DISCORD_RETENTION_DAYS`(기본 30일)가
지나면 notification worker가 Discord에서 삭제한다.

P6 agent runtime은 `k8s/seori-auth-agent-runtime.yaml`에 별도로 있고 기본 scale은 0이다. 이 manifest는
Secret 값을 만들지 않으며 canonical catalog에서 공개 identity를 확인한 실행 복제본만 projected volume으로
받는다. runtime은 exact SPIFFE client certificate를 사용하는 K8s mTLS만 지원한다. local transport 코드는
포함하지 않으며 동일 UID Codex/Claude를 구분할 native peer attestor나 전용 OS UID 경계가 구현되기 전에는
local client와 runtime을 모두 제공하지 않는다.
client 요청 body는 stdin으로만 받고 bearer/private key 경로나 값을 argv와 stdout에 넣지 않는다.

### 서리 재무 리포트

종량제 비용은 매일 09:00 KST(`backoffice-finance-report` CronJob → `/api/admin/finance-report`)에
`#app-ops`로 나간다. 리포트는 결정적 수치라 LLM을 쓰지 않는다.

- 소스 4종: GitHub Actions 분량·과금, GCP billing export, `ai_usage` 원장의 LLM 비용,
  Stability 크레딧. 임계(GitHub 70/90% + 실청구, GCP·LLM 예산 70/100%, Stability 경고선)를
  넘으면 경고 항목이 붙는다.
- 관련 key는 전부 optional이며 미설정 소스는 리포트에 "미설정"으로 드러난다.
  `GITHUB_BILLING_TOKEN`(조직 billing 읽기 전용 fine-grained PAT, 키체인
  `com.seorilabs.github.billing-pat`), `GCP_BILLING_EXPORT_TABLE`, `STABILITY_API_KEY`.
  GCP billing 조회는 GA4 수집과 같은 read 전용 SA(`GA4_SA_KEY_JSON`)를 쓴다.
- 예산 값은 웹 Pod의 `GCP_MONTHLY_BUDGET_KRW`, `LLM_MONTHLY_BUDGET_USD`(0=보고만).
- 게시 정체는 서리 봇(`DISCORD_TEAMMATE_SEORI_BOT_TOKEN`, optional)이다. 알림 outbox의
  payload `sender` 키로 notification worker가 토큰을 고르며, 보존기한 삭제도 같은 정체로
  한다. 토큰이 없으면 메인 봇으로 나가므로 리포트가 사라지지는 않는다.
- 수동 발화: `kubectl -n platform create job --from=cronjob/backoffice-finance-report finance-report-manual-<고유번호>`.
- 같은 수치는 `/ask`의 `cost_summary` 도구로도 즉시 조회할 수 있다.

### 서리 지표 하이라이트

매일 11:00 KST(`backoffice-metric-highlights` CronJob → `/api/admin/metric-highlights`)에
GA4·AppsInToss 콘솔 스냅샷에서 크게 움직인 항목만 추려 `#app-ops`로 나간다. 서리 봇 정체로
게시하며 판정은 전부 결정적이라 LLM을 쓰지 않는다.

- 전량 나열은 `#metrics-daily`의 지표 리포트(10:30 KST)가 이미 한다. 이 리포트는 판단만 남긴다.
- 스케줄은 `analytics-collect`(10:00 KST) → 지표 리포트(10:30 KST) 뒤라 D-1 스냅샷이 이미 있다.
  BigQuery·콘솔을 직접 치지 않고 저장된 `app_metric_daily`·`app_console_metric_daily`만 읽는다.
- 판정: 최신값 vs 직전 7일 **중앙값**. 관측 4일 미만이면 판정하지 않고, 기준선이 지표별
  최소 표본에 못 미치면 "표본 부족"으로 뺀다. 하루짜리 튐이 기준선을 흔들지 않게 평균이
  아니라 중앙값을 쓴다(기존 이상 감지와 같은 방식).
- 지표와 임계: GA4 DAU(기준선 10명·±30%), D1 잔존율(5%·±10%p), 보상형 광고 완료(20회·±40%),
  콘솔 DAU(10명·±30%), 광고 수익(₩1,000·±40%), 결제 거래액(₩1,000·±40%).
  잔존율만 %p로 보고 나머지는 상대 변화로 본다.
- 정렬은 `변화 크기 × log10(기준선)` — 작은 앱의 큰 변화율이 판을 덮지 않게 규모를 반영한다.
  각 방향 상위 5건까지 싣는다.
- 기준선이 0인데 값이 임계 이상 생기면 "신규"로 하이라이트에 올린다(첫 매출 등).
- 콘솔은 온디맨드 push라 리스팅마다 최신일이 다르다. 기준일보다 오래된 스냅샷은 항목 줄에
  `⏳<날짜>`를 함께 찍는다.
- 수동 발화: `kubectl -n platform create job --from=cronjob/backoffice-metric-highlights metric-highlights-manual-<고유번호>`.

#### AI 팀원 체계 폐기 (2026-08-27)

담당제 AI 팀원 6명(오너 노을/이슬/바람/새벽/마루 + 총괄 서리)의 순찰·스탠드업·주간
리포트·이슈 초안 카드·멘션 대화를 모두 걷어내고 서리 재무 리포트만 남겼다. 서리는 봇
정체로만 남고 멘션에 응답하지 않는다 — 질의는 메인 봇 `/ask`가 같은 도구로 답한다.

배포 후 사람이 1회 정리할 항목:

```bash
# apply 로 지워지지 않는 구 CronJob 7개
kubectl -n platform delete cronjob \
  backoffice-teammate-patrol-{seori,noeul,iseul,baram,saebyeok,maru} \
  backoffice-teammate-standup
# 더 이상 배포되지 않는 워커
kubectl -n platform delete deploy backoffice-teammate-worker
```

- 오너 봇 5개(`DISCORD_TEAMMATE_{NOEUL,ISEUL,BARAM,SAEBYEOK,MARU}_*` 10키)는 SealedSecret에
  그대로 두었다. 폐기하려면 Developer Portal에서 앱을 지우고 재봉인한다. 서리 2키는 유지한다.
- `app.ownerTeammate`, `teammate_run`, `discord_turn.teammate`, `ai_usage.teammate`는 읽는
  코드가 없지만 컬럼·테이블은 남아 있다. expand-only 게이트가 `DROP`을 막으므로 제거는
  별도 contract 단계와 승인으로 한다.

## 9. Gemini Stage Agent (단계별 AI)

각 라이프사이클 단계에 AI 에이전트를 배치. **AI 는 GitHub 에 직접 쓰지 않고** `AiDraft` 초안만 만든다 → 사람이 검토/수정 → 1클릭 커밋(이슈 생성/코멘트) → webhook 으로 미러 수렴.

- **모델**: `gemini-3.1-flash-lite` GenerateContent API. 비용·지연을 줄이기 위해 `minimal` thinking을 명시하고 Gemini 3 권장에 따라 temperature를 별도 지정하지 않는다.
- **활성 조건**: `FEATURE_GEMINI_ENABLED=true` AND `GEMINI_API_KEY` 비어있지 않음(`env.geminiChatConfigured()`).
- **일일 다이제스트 슬로우 롤아웃**: 전일 KST 기준 default branch 병합 PR 목록은 Gemini 없이 매일 발송한다. AI 한 줄만 `DAILY_DIGEST_GEMINI_ROLLOUT_PERCENT`의 날짜별 고정 샘플에 적용하며 초기값은 `10`이다. Free API 쿼타와 결과 품질을 확인한 뒤 `25 → 50 → 100`으로 올린다.
- **키 출처/회전**: `~/.config/seorilabs/gemini-cluster-api-keys.env`의 Backoffice 전용 회사 키를 `backoffice-secrets`(platform ns)에 보관한다. PR bot과 Vault 배치 인덱서 키를 재사용하지 않는다.
  ```bash
  set -a
  source ~/.config/seorilabs/gemini-cluster-api-keys.env
  set +a
  printf '%s' "$GEMINI_BACKOFFICE_API_KEY" | kubeseal --raw --namespace platform --name backoffice-secrets \
    --controller-namespace kube-system --controller-name sealed-secrets-controller
  # 출력 암호문을 k8s/backoffice-sealedsecret.yaml의 GEMINI_API_KEY에 넣고 apply
  ```
- **에이전트(현재)**: 기획(`PLANNING_SPEC`, `/plan` AI 버튼→폼 채움), 분해(`TASK_BREAKDOWN`, 앱 상세→대상 이슈 코멘트), 릴리스노트(`RELEASE_NOTES`, 앱 상세→새 이슈+`release-notes` 라벨). 코드 작성은 하지 않음(자율 Claude routine 담당).
- **스키마**: `ai_draft` 테이블(마이그레이션 `1_ai_draft`). DRAFT→COMMITTED/DISCARDED.

## 10. 이미지 빌드 — hosted 크로스빌드

`deploy.yml` 의 `build` 잡은 `verify` 와 migration contract 성공 뒤 GitHub-hosted 러너에서 arm64 이미지를 만들어 `registry.vzyx.xyz` 로 push한다. 이
레지스트리는 TLS 로 공개 도달 가능하다.

- **크로스빌드**: 의존성 설치와 `next build` 는 Dockerfile 의 `--platform=$BUILDPLATFORM`
  스테이지에서 러너 네이티브 아키텍처로 돈다. 런타임 스테이지만 arm64 이고, 그 안의
  RUN(apt, `corepack enable`, `useradd`, `npm install -g prisma`)만 QEMU 로 에뮬레이션된다.
  무거운 JS 빌드에 QEMU 가 개입하지 않는다.
- **산출물이 아키텍처와 무관한 근거**: Next standalone 은 순수 JS 이고, Prisma arm64
  query engine 은 `schema.prisma` 의 `binaryTargets` 로 명시 생성되며, sharp 는
  `next.config.ts` 의 `outputFileTracingExcludes` 로 트레이스에서 제외했다. **sharp 제외를
  되돌리면 빌드 호스트 아키텍처의 `.node` 바이너리가 arm64 이미지에 딸려 들어간다.**
  `images.unoptimized` 로는 제외되지 않는다(실측). 이 앱은 `next/image` 를 쓰지 않는다.
- **캐시**: `cache-from/to: type=gha`. 의존성 무변경이면 `pnpm install` 레이어를 재사용한다.
  BuildKit cache mount(pnpm store·`.next/cache`)는 러너가 ephemeral 이라 유지되지 않는다.
- **메모리**: Dockerfile `NODE_OPTIONS=--max-old-space-size=2048` 로 `next build` 힙 상한.
- **PR CI만 `pnpm build`를 실행**하고 main Deploy의 `verify`는 이를 생략한다. production
  `next build`는 Dockerfile에서 한 번 실행하며 `eslint.ignoreDuringBuilds`/
  `typescript.ignoreBuildErrors`는 선행 verify 잡이 게이트한다.
- **`k8s/buildkitd.yaml` 과 PVC `buildkit-cache`(25Gi)는 이 경로에서 더는 쓰지 않는다.**
  클러스터에는 남아 있으므로 회수는 별도 판단이다.
- **주의**: CronJob 등 매니페스트 변경은 CI(`set image`)로 반영 안 됨 → `kubectl apply` 1회 필요.

## 11. Vault RAG — Obsidian 볼트 지식 + 벡터검색 + 받은함 쓰기

Syncthing(`data` ns, hostPath `/data/syncthing`, rpi5)이 동기화하는 **Obsidian 메인 볼트**(`Sync/obsidian-main`, .md ~1.2k)를 Gemini 지식 원천으로 인덱싱한다. PVC(`syncthing-pvc`, RWO, `data` ns)는 네임스페이스 스코프라 `platform` 의 backoffice 가 직접 못 붙는다 → **인덱서/라이터는 `data` ns CronJob**(같은 rpi5, RWO 동시 마운트), backoffice 는 **MySQL `vault_chunk` 만 조회**.

```
data ns                                   platform ns
 vault-indexer CronJob (매일 KST 05:00)    search_knowledge 챗 도구(Gemini 자동 호출)
   PVC ro → chunk → gemini-embed →         /api/admin/vault/probe  (임베딩 실측, 키 비노출)
   vault_chunk(embedding LONGBLOB)         /api/admin/vault/search (검색 점검)
 vault-writer CronJob (매일 KST 04:30)     enqueueVaultWrite → vault_write_request
   PENDING 드레인 → 받은함/*.md (uid 1000)   (텔레그램 /save)
```

- **임베딩**: **Google Gemini `gemini-embedding-001`**(`:batchEmbedContents`, 1536dim, taskType RETRIEVAL_DOCUMENT/QUERY 비대칭). 챗/추론은 `gemini-3.1-flash-lite`를 사용한다. 벡터는 ANN 인덱스(HeatWave 전용) 없이 **float32 LONGBLOB 저장 + 앱 brute-force cosine**(cosine 은 스케일 불변이라 정규화 불필요). 검색측은 임베딩만 메모리 캐시(시그니처 변하면 갱신).
- **키 분리**: `platform/backoffice-secrets`는 Backoffice 챗과 검색 질의 임베딩, `data/backoffice-vault-secrets`는 배치 문서 인덱싱에 각각 별도 회사 키를 사용한다.
- **인덱싱 범위 = 최상위 폴더 allowlist** `VAULT_INCLUDE_DIRS=프로젝트,지식,받은함,자료`(+`.obsidian` 등 메타 제외). ⚠️ **블록리스트 금지 교훈**: 볼트에 시크릿(니모닉·access key·kubeconfig)이 `보관함/EpicLeague/Keep/` 등 `비공개` 아닌 폴더에도 흩어져 있어 "비공개만 제외" 시 Gemini API로 유출됨 → **화이트리스트로 전환**. 증분(파일 sha256 == DB fileHash 면 스킵), allowlist 밖 기존 청크는 인덱서 삭제 로직이 자동 purge.
- **쓰기 안전장치**: 에이전트는 **받은함**(`VAULT_WRITE_FOLDERS` allowlist)에 **draft .md 만** 생성, 기존 노트 수정/삭제 불가. 사람이 Obsidian 에서 검토. writer 는 파일 소유자 **uid 1000** 으로 실행해야 기록 가능.

**배포 런북**
1. 이미지에 `scripts-dist/{index-vault,vault-writer}.cjs` 포함(Dockerfile `pnpm build:scripts`, @prisma/client external → standalone node_modules 재사용). 최신 이미지 배포 후 진행.
2. data ns 에 pull cred + 전용 시크릿:
   ```sh
   kubectl -n platform get secret registry-pull-cred -o yaml \
     | sed 's/namespace: platform/namespace: data/' | kubectl -n data apply -f -
   kubectl -n data create secret generic backoffice-vault-secrets \
     --from-literal=DATABASE_URL='mysql://backoffice:***@mysql.data.svc.cluster.local:3306/backoffice?connection_limit=3' \
     --from-literal=GEMINI_API_KEY='***'
   ```
   backoffice(platform, 질의측)에도 `GEMINI_API_KEY` 필요 → `backoffice-secrets` 에 추가하고 `kubectl apply -f k8s/deployment.yaml`(env 변경은 CI set image 비대상).
3. `kubectl apply -f k8s/vault-rag.yaml`.
4. **임베딩 실측(키 비노출)**: `curl -fsS -XPOST -H "x-admin-token: $TOK" https://backoffice.vzyx.xyz/api/admin/vault/probe` → `{ok:true, provider:"gemini", dim:1536}`.
5. 최초 인덱싱: `kubectl -n data create job --from=cronjob/vault-indexer vault-index-init` → 로그로 `result {scanned,changed,chunks}` 확인.
6. 검색 점검: `curl -XPOST -H "x-admin-token: $TOK" -d '{"q":"게임 아이디어"}' .../api/admin/vault/search`. 텔레그램에서 `/save 테스트 메모` → 다음 KST 04:30 writer 실행 뒤 받은함에 파일. 즉시 처리해야 하면 `kubectl -n data create job --from=cronjob/vault-writer vault-writer-manual-$(date +%s)`를 사용한다.

- **즉시 재인덱싱 트리거**: 텔레그램 `/index` 또는 `POST /api/admin/vault/reindex` → backoffice 가 K8s API 로 `data` ns 에 인덱서 Job 생성(`src/lib/k8s/vault-trigger.ts`, 파드 SA 토큰+CA, 의존성 0). 실행 중이면 중복 방지, 완료 후 ttl 자동 정리. 평소 2h 자동 증분과 별개로 "방금 쓴 문서 바로 검색" 용도. RBAC: `k8s/vault-trigger-rbac.yaml`(SA `backoffice` + data ns Role: cronjobs get, jobs create/list/get), deployment `serviceAccountName: backoffice`.

> **주의**: `vault-rag.yaml`·`deployment.yaml`·`vault-trigger-rbac.yaml` 변경은 CI(`set image`) 비대상 → `kubectl apply` 1회. `/index`와 `POST /api/admin/vault/reindex`의 즉시 인덱싱은 일일 스케줄과 무관하게 유지된다. 임베딩은 Gemini 결제 키(Tier 1)라 throttle 무관. 증분은 변경 파일만 임베딩(비용 거의 0).

## 11-1. Stable 릴리스 오케스트레이션 (태그 → 배포)

백오피스가 stable 릴리스에서 지키는 원장. 설계 정본은 `docs/ci-cd/org-cicd-release-system.md` §7.2.

**릴리즈 마커 커밋 정책은 폐기됐다.** 예전에는 태그 생성 시 파일 변경이 없는 `chore(release): vX.Y.Z` 커밋을 default branch 에 push 하고 그 커밋에 태그를 달았다. 이 방식은 릴리즈 소스를 빈 커밋으로 만들고 브랜치 HEAD 까지 움직여, 태그가 가리키는 소스와 실제 배포 대상이 갈라지는 원인이 됐다. 지금은 마커를 만들지 않고 검증한 소스 SHA 에 태그를 직접 단다. 폐기 이전에 쌓인 마커 커밋만 출시노트 집계에서 계속 제외한다(`src/lib/core/release-marker-history.ts`, 읽기 전용).

### 태그 생성 — preview / confirm 2단계

| 단계 | 하는 일 | 외부 write |
|---|---|---|
| preview | repo 의 default branch 를 조회해 **exact SHA 를 고정**하고, 그 SHA 의 소스 원장에서 후보 태그를 확정한다 | 없음 |
| confirm | 같은 SHA·후보 태그·소스 버전을 **다시 검증**한 뒤에만 `createTag` → `createOrUpdateRelease` | 검증 통과 후에만 |

- 확인 사이에 default branch 가 움직였으면 write 없이 중단한다.
- `bump` 는 소스에 없는 버전을 만들지 않는다. pinned-source repo 는 후보 태그가 항상 소스 버전이며, 버전을 올리려면 repo 의 원장을 먼저 올린다.
- 소스 버전 계약(`src/lib/core/release-source-contract.ts`)은 SHA 시점의 repo-local 선언으로 판별한다. `scripts/check_release_version.py`=pinned-source(3원장 정합+태그 일치 강제), `scripts/resolve-release-version.mjs`=tag-derived, 둘 다 없으면 tag-derived-caller.

### 배포 — preflight 전부 → GitHub → Xcode Cloud

```mermaid
flowchart TD
  A["배포 요청 - tag, target"] --> B["preflight - 외부 write 0"]
  B --> B1["태그가 가리키는 exact SHA"]
  B --> B2["그 SHA 의 소스 버전 계약"]
  B --> B3["caller workflow_dispatch 선언"]
  B --> B4["보낼 inputs 가 전부 선언돼 있는지"]
  B --> B5["Xcode Cloud 제품 - repo - 수동 태그 조건"]
  B1 --> C{"전부 통과"}
  B2 --> C
  B3 --> C
  B4 --> C
  B5 --> C
  C -- "아니오" --> X["재시도 불가 오류 - 외부 write 0회"]
  C -- "예" --> D["GitHub workflow_dispatch"]
  D -- "422 등 거부" --> X2["중단 - Xcode Cloud write 0회"]
  D -- "성공" --> E["Xcode Cloud ciBuildRuns - 마지막"]
```

- 되돌릴 수 없는 Xcode Cloud 실행이 항상 마지막이다. GitHub 이 거부하면 `ciBuildRuns` 는 0회로 남는다.
- `APPSTORE` 단독도 같은 preflight 를 전부 통과한 뒤에만 `ciBuildRuns` 를 만든다.
- 배포 audit(`release.deploy.dispatch`)에는 검증된 태그 SHA 와 실제 dispatch 결과만 남긴다.
- 개별 마켓 workflow 내부의 exact 버전 검증은 마지막 방어막으로 그대로 둔다.

## 12. 출시노트 (Release Notes) — 태그 diff 기반 8개 언어 유저 공지

릴리즈 태그(`v*`) push 시 **이전 릴리즈 태그~새 태그**의 변경(머지 PR/커밋)을 GitHub compare 로 모아 Gemini로 **사용자용 출시노트(ko_KR/en_US/ja_JP/zh_CN/zh_TW/de_DE/fr_FR/es_ES)** 를 생성, `release_note` 테이블에 저장한다. 백오피스 `/release-notes`(전역 타임라인) + 앱 상세 "출시노트" 섹션에서 언어별로 전문을 열람할 수 있고, `Android용 전체 복사`로 Google Play Console의 `<ko-KR>...</ko-KR>` 일괄 입력 형식을 복사할 수 있다.

태그와 GitHub Release 생성은 번역을 기다리지 않는다. 정식 tag push는 공개 ref·version·source SHA만 체크섬으로 봉인해 `AutomationIngressEvent`에 먼저 기록한다. webhook 응답 이후 Next.js `after`가 exact inbox event를 소진하고, 실패하면 scheduler가 같은 event를 재생해 GitHub Release 본문과 `release-notes.json` 에셋을 갱신한다.

```mermaid
flowchart LR
  TAG["태그 push refs/tags/v*"] --> INBOX["durable inbox - SHA와 checksum"]
  INBOX -->|webhook 200 이후 또는 scheduler replay| GEN["generateAndPublishReleaseNotes"]
  GEN --> CMP["compareCommitsWithBasehead(prev...new)"] --> AI["Gemini → JSON 8개 언어"] --> DB[("release_note")]
  DB --> UI["/release-notes + 앱상세"]
  DB --> GH["GitHub Release 본문 + release-notes.json 갱신"]
```

- **트리거(자동)**: webhook `push` + `created` + `ref=refs/tags/v*`. **⚠️ GitHub App 이 `push` 이벤트를 구독해야 자동 발화** — App 설정 > Permissions & events > Subscribe to events > **Push** 체크(미구독 시 자동 생성 안 됨, 수동 백필은 가능).
- **Platform 소유권**: `${GITHUB_ORG}/platform`의 공개 GitHub Release와 immutable `release-notes.json`은 Platform publisher만 소유한다. Backoffice 자동 발행과 durable replay는 이 exact repo를 처리 완료로 소진하되 외부 write를 하지 않는다. 다른 저장소의 tag 동작은 유지한다.
- **수동 백필/재생성**: `POST /api/admin/release-notes/generate`(x-admin-token) body `{repo, version, headSha?}`. 멱등 upsert(`@@unique([repoFullName, version])`).
- **생성 로직**(`src/lib/core/release-notes.ts`, `src/lib/github/release.ts`): `listVersionTags`(semver 내림차순) → `previousTag` → `compareTags`(머지 PR 추출: `(#N)`/`Merge pull request #N`) → `buildReleaseNotesI18nPrompt` → Gemini JSON(`parseLooseJson` 견고 파싱).
- **untagged 보정**: deploy `workflow_run` 의 head_branch 가 버전이 아니면(main 등) `findTagForSha(head_sha)` 로 태그를 조회해 ReleaseRecord.version 복원(출시 매트릭스). 태그 없으면 "untagged" 유지(연속배포).
- 마이그레이션 `6_release_note`, `14_release_note_i18n`. webhook 은 생성이 느려도 200 을 막지 않도록 durable inbox 기록 뒤 Next.js `after`에서 후처리한다.

## 13. Discord 배포 완료 알림

- `/release` 앱 목록은 GitHub 레지스트리를 서버 부팅 30초 후와 6시간마다 자동 재스캔한다. 명령 첫 줄의 `앱 목록 새로고침`으로 즉시 재스캔할 수도 있다. `game/project.godot` 레이아웃을 포함하며 한국어 마켓명·Godot명·짧은 한국어 저장소 설명을 우선 표시한다.
- GitHub 마켓 배포는 `workflow_run.completed`를 `ReleaseRecord`에 반영한 뒤 `notification_event`/`notification_delivery` outbox에 `release-ops` 목적지로 성공·실패 알림을 멱등 큐잉한다.
- 알림에는 한글 앱명, 릴리즈 태그, 마켓, 실행 이름, GitHub Actions 실행 링크가 포함된다.
- 릴리즈 요청·진행·성공·실패·롤백은 `notification_delivery.providerMessageId`로 같은 Discord 카드를 `PATCH /messages/{id}`로 갱신한다. `Unknown Message`(코드 `10008`)일 때만 새 카드를 만들고, 그 밖의 실패는 중복 전송 없이 outbox 재시도로 남긴다.
- Discord API의 일시 오류는 요청 내 재시도 후 outbox가 30초 지수 backoff, 최대 30분 간격으로 재시도한다. 전송 성공·실패는 `AuditLog`의 `notification.sent`/`notification.failed` action으로 확인한다.
- Xcode Cloud App Store 배포는 `ReleaseRecord.externalRunId`로 실행을 저장하고 서버 scheduler가 Node 전용 admin route를 통해 1분마다 App Store Connect `ciBuildRuns/{id}`를 조회한다. 완료 결과는 동일 outbox로 알리고 성공 시 기존 라이프사이클 전이도 실행한다.
- `lucid-chess`는 `com.etlegame.chess` Xcode Cloud 제품과 `Lucid Chess Release` workflow를 사용한다. repo의 표준 `deploy-app-store.yml`이 market target 신호를 제공하고, Backoffice allowlist가 GitHub dispatch 대신 ASC `ciBuildRuns` 경로를 선택한다.
- `cycle-pair`는 `com.seorilabs.cyclepair` Xcode Cloud 제품과 `Cycle Pair Release` workflow를 사용한다. 같은 제품에 다른 repo workflow가 남아 있어도 workflow repository가 요청 repo와 정확히 일치하는 `APP_STORE_ELIGIBLE` iOS Archive만 선택하며, 0개 또는 복수면 실행하지 않는다.
- `lizard-tycoon`은 `com.seorilabs.lizardtycoon` Xcode Cloud 제품(`LizardTerrarium`)과 `Lizard Tycoon Release` workflow를 사용한다. Godot repo라 `xcode-cloud/LizardTerrarium.xcodeproj`가 bootstrap container이고, `ci_post_clone.sh`가 태그 커밋에서 Godot iOS 프로젝트를 재생성한다. workflow에는 환경변수 `GODOT_ANALYTICS_ID`와 secret `GODOT_ANALYTICS_SECRET`이 있어야 빌드가 통과한다.
- `jomul`은 `com.seorilabs.jomul` Xcode Cloud 제품과 `Jomul App Store Archive` workflow를 사용한다. 2026-08-16 live readback에서 primary repository `seorilabs/jomul`과 활성 `APP_STORE_ELIGIBLE` iOS Archive workflow가 정확히 하나임을 확인했다. repo의 `deploy-app-store.yml`은 마켓 지원 탐지용 fail-closed 표준 진입점이며, 실제 App Store 실행은 Backoffice가 ASC API로 Xcode Cloud에 요청한다.
- 관련 마이그레이션: `16_deploy_completion_notifications`, `20_discord_operational_notifications`, `24_drop_telegram_legacy`.

## 14. AppOps Kubernetes worker

앱별 관리 도구는 GitHub Actions를 실행기로 사용하지 않는다. 백오피스 API가
`app_operation_run`에 검증된 요청을 적재하고, 별도
`backoffice-app-ops-worker` Deployment가 게임별 최소권한 identity로 처리한다.

- 웹 Pod에는 게임 자격증명을 주입하지 않는다.
- worker 전용 Secret 이름은 `backoffice-app-ops-secrets`다.
- 공통 플랫폼 Admin API는 읽기/쓰기를 분리한다. 웹 Pod의
  `PLATFORM_ADMIN_READ_SA_KEY_JSON`은 조회만 가능하고, worker의
  `PLATFORM_ADMIN_WRITE_SA_KEY_JSON`만 지급·회수를 호출할 수 있다.
- 이 분리는 read 키 유출에 의한 직접 mutation과 write 키 탈취를 막는 경계다.
  웹과 worker가 공유하는 queue/MySQL 무결성까지 보장한다는 뜻은 아니다.
  worker는 실행 직전에 현재 allowlist·role·앱 OWNER·ACTIVE 상태와
  `AppOperationRun.appId`/`params.appSlug`를 다시 결합한다.
- 두 Pod가 공유하는 `PLATFORM_ADMIN_URL`은 각 Secret에 같은 Cloud Run
  URL로 넣는다. 과거 단일 `PLATFORM_ADMIN_SA_KEY_JSON`은 사용하지 않는다.
- 웹의 `FEATURE_PLATFORM_ADMIN=true`는 조회 화면만 연다. mutation은 별도
  `FEATURE_PLATFORM_ADMIN_WRITES`가 `true`여야 action과 앱별 legacy cutover가
  함께 열린다. 기본값은 웹·worker 모두 `false`다.
- worker manifest의 두 플랫폼 플래그 기본값도 `false`다. 플랫폼 registry의
  대상 앱 `features.iap`, 앱별 catalog, URL·write Secret을 먼저 준비한 뒤
  마지막 배포에서 worker의 `FEATURE_PLATFORM_ADMIN`과 양쪽 Pod의
  `FEATURE_PLATFORM_ADMIN_WRITES`를 함께 `true`로 전환한다. URL 또는 write
  키 없이 write 플래그를 켜면 worker는 큐를 잡기 전 기동 단계에서 실패한다.
  전환 뒤 도마뱀 grant·revoke·reset은 legacy Firebase 직접 쓰기로 fallback하지
  않고 공통 `/platform/iap` 화면만 허용한다.
- 도마뱀 IAP 키는 `LIZARD_TYCOON_APP_OPS_SA_KEY_JSON`이며
  `lizard-tycoon` 프로젝트의 `roles/datastore.viewer`와 프로젝트 custom role
  `iapSandboxLedgerResetter`만 부여한다. custom role은 sandbox 테스트 원장의 보상 전이에 필요한
  `datastore.entities.create`·`datastore.entities.update`만 포함한다.
- 조회 결과는 MySQL에 미러하지 않는다. 승인된 mutation command의 PUID,
  entitlement, typed confirmation과 고정 reason code만 `AppOperationRun`에
  최대 24시간 보관한다. 확정 결과는 즉시 입력을 제거하고, 결과 불명만 동일
  request ID 재실행을 위해 TTL까지 보존한다. 영수증, 구매 토큰, 비밀번호,
  개인키는 요청이나 결과에 포함하지 않는다.
- 브라우저에는 결과 불명 복구용 `requestId`·앱·operation만 저장한다. PUID,
  entitlement, reason, confirmation은 저장하지 않으며 새 ID 재발급을 막는다.
- 서버 enqueue는 MySQL의 대상 `app` row를 `FOR UPDATE`로 잠근 뒤 앱별 중앙
  플랫폼 요청을 한 건씩만 만든다. localStorage는 crash 복구 보조 수단이며
  여러 탭의 동시 지급을 막는 최종 경계가 아니다.
- worker는 처리 중 중단된 요청을 최대 세 번 재시도한다.
- `iap-ledger.reset-app-store-sandbox`는 Apple Sandbox 구매 내역을 먼저 지운 계정에만 사용한다.
  production·Google Play source와 처리 주문 문서는 삭제하지 않고 App Store source를
  `revoked`로 전이하며 request ID로 멱등 처리한다.

custom role과 실행 identity binding은 다음처럼 구성한다.

```sh
gcloud iam roles create iapSandboxLedgerResetter \
  --project=lizard-tycoon \
  --title="IAP Sandbox Ledger Resetter" \
  --permissions=datastore.entities.create,datastore.entities.update \
  --stage=GA
gcloud projects add-iam-policy-binding lizard-tycoon \
  --member=serviceAccount:iap-backoffice-ops@lizard-tycoon.iam.gserviceaccount.com \
  --role=projects/lizard-tycoon/roles/iapSandboxLedgerResetter
```

최초 부트스트랩은 평문 JSON을 출력하지 않고 파일 입력으로 Secret을 만든 뒤 SealedSecret으로
관리한다.

```sh
kubectl -n platform create secret generic backoffice-app-ops-secrets \
  --from-file=LIZARD_TYCOON_APP_OPS_SA_KEY_JSON=/secure/path/lizard-app-ops.json \
  --from-literal=PLATFORM_ADMIN_URL='https://platform-admin-xxxxx.run.app' \
  --from-file=PLATFORM_ADMIN_WRITE_SA_KEY_JSON=/secure/path/platform-admin-write.json
kubectl apply -f k8s/ci-deployer-rbac.yaml
kubectl apply -f k8s/app-ops-worker.yaml
```

Secret 생성 후에도 worker의 두 플래그와 웹의
`FEATURE_PLATFORM_ADMIN_WRITES`는 그대로 `false`로 먼저 배포한다. 플랫폼
registry sync와 catalog 검증이 끝난 것을 확인한 뒤 worker의 조회 플래그와
양쪽 write 플래그를 함께 `true`로 바꿔 재배포한다. 세 전제 중 하나라도
준비되지 않았으면 웹은 읽기 전용으로 두고 기존 앱별 mutation 경로를
유지한다.

배포 workflow는 exact-digest Prisma migration Job을 먼저 끝낸 뒤 웹 Deployment를
가용성 보존 방식으로 교체하고 worker/CronJob을 같은 image digest로 갱신한다. data ns의
Vault CronJob이 설치돼 있으면 최소권한 Role로 두 image도 같은 digest에 맞춘다. 검증은
migration Job, 웹 endpoint 연속성, 각 workload image, worker 로그, DB 요청 상태,
실제 게임 데이터 readback 순서로 수행한다.

## 15. Discord 마켓 리뷰 알림

`backoffice-store-reviews` CronJob은 30분마다 `ACTIVE` 앱 중 실제
`marketTargets`와 `playPackage`/`iosBundle`이 모두 있는 대상을 수집한다.

- Google Play: Android Publisher API `reviews.list`, 공용 카탈로그 자격증명
  `shared/google-play/publisher`의 실행 복제본 `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` 사용.
- App Store: App Store Connect API `customerReviews`, 기존 공용 자격증명
  `shared/apple/app-store-connect-uploader`의 세 환경변수 사용.
- 범위는 두 공식 API가 반환하는 개별 리뷰 resource와 그 1~5점 평점이다.
  스토어 전체 평균 평점의 집계값 변동은 이 collector 대상이 아니다.
- 첫 성공 수집은 기존 리뷰를 `store_review_sync` 기준선으로만 기록하며 Discord에
  보내지 않는다. 이후 새 리뷰와 동일 리뷰 ID의 별점·제목·본문 수정만
  `#user-reviews` outbox에 멱등 enqueue한다.
- 작성자명과 리뷰 원문은 `store_review_observation`에 저장하지 않는다. 리뷰 ID,
  표시 내용 hash, 별점, 원본 시각만 보존한다. Discord 메시지와 전송용 리뷰
  outbox payload는 일반 알림과 같은 보존기한 뒤 제거한다.
- `DISCORD_CHANNEL_USER_REVIEWS_ID`가 없으면 API 호출이나 최초 기준선 생성을 하지
  않고 실패한다. 채널 누락 상태에서 과거 리뷰를 조용히 소비하지 않기 위한 gate다.

배포 전에 평문을 출력하지 않는 파일 입력 방식으로 Google JSON을 Secret에 추가하고,
App Store 키 3종과 `DISCORD_CHANNEL_USER_REVIEWS_ID`가 존재하는지 확인한다. 배포 후에는
임시 Job으로 최초 실행해 `baselined > 0`, `enqueued = 0`, `errors = []`를 확인한 뒤
새 테스트 리뷰 1건으로 enqueue·Discord 수신을 각각 검증한다.
