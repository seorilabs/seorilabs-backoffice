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
- **Permissions(Repository)**: Metadata=Read, Contents=Read, Pull requests=Read, Actions(Workflows)=Read, Checks=Read, **Issues=Read & Write**.
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

# backoffice-secrets (k8s/secret.example.yaml 참고)
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
  --from-literal=MINIMAX_API_KEY=''
```

## 4. 이미지 빌드 & 배포
CI(`.github/workflows/deploy.yml`)가 push main 시 빌드/푸시/롤아웃. 필요 GitHub secrets:
- `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` (registry.vzyx.xyz push)
- `KUBECONFIG_B64` (platform ns deployment patch 권한 SA kubeconfig, base64)

수동 최초 배포:
```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/backup-cronjob.yaml
kubectl -n platform rollout status deployment/backoffice --timeout=300s
```
initContainer `migrate` 가 `prisma migrate deploy` 로 스키마 적용.

## 5. 시드 + 검증
```bash
# 레지스트리 시드 + backfill (헤드리스)
TOKEN=$(kubectl -n platform get secret backoffice-secrets -o jsonpath='{.data.INTERNAL_ADMIN_TOKEN}' | base64 -d)
kubectl -n platform exec deploy/backoffice -- \
  sh -c "curl -fsS -XPOST -H 'x-admin-token: $TOKEN' http://localhost:3000/api/admin/seed"
# 또는 로그인 후 /settings 의 "레지스트리 시드/재스캔"
```
검증:
- `https://backoffice.vzyx.xyz/login` TLS valid → GitHub 로그인(allowlist).
- `/board`, `/issues`, `/releases` 에 시드 데이터 표시.
- GitHub App > Advanced > Recent Deliveries → Redeliver 로 webhook 200 확인.
- 보드 드래그 전이 → 새로고침 후 유지. deploy workflow_run 성공 시 출시 자동전이.

## 6. 운영 메모
- 라이프사이클 상태는 GitHub 에 없음 → `backoffice-db-backup` CronJob(일 1회) 유지. 복구 시 dump restore 후 reconcile.
- reconcile 은 부팅 시 1회 + `RECONCILE_INTERVAL_MS`(기본 6h). `DISABLE_SCHEDULER=true` 로 비활성.
- MiniMax Stage Agent 는 `FEATURE_MINIMAX_ENABLED=true` + `MINIMAX_API_KEY`(§9).

## 7. CI 자동배포 설정 (main push → 빌드/배포)

`deploy.yml` 은 push main 시 `-dind` 러너에서 이미지 빌드/push 후 `-arm64` 러너에서 `kubectl set image`. 아래 3개를 1회 셋업한다.

**(a) 배포용 SA + kubeconfig**
```bash
kubectl apply -f k8s/ci-deployer-rbac.yaml

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

**(c) ARC 러너 그룹**
org Settings → Actions → Runner groups → **RPI ARM64 Builders** 의 repository access 에 `seorilabs-backoffice` 추가(아니면 job 이 queued 로 멈춤).

이후: main push → 자동 배포. 수동 재배포는 Actions → **Deploy** → Run workflow.

## 8. Sealed Secrets (시크릿 git 버전관리)

`backoffice-secrets`는 **암호화된 채 git에 보관**된다(`k8s/backoffice-sealedsecret.yaml`). kube-system 의 `sealed-secrets-controller`(v0.38.1)가 복호화해 실제 Secret 을 생성.

- **봉인 키 백업(필수·DR)**: `~/.config/seorilabs/sealed-secrets-master.key.yaml` — 이 키가 없으면 클러스터/컨트롤러 유실 시 SealedSecret 복호화 불가. **반드시 오프머신 안전 보관**. git 커밋 금지.
- **시크릿 추가/회전**: 임시 평문 Secret 을 만들고 봉인 → 재커밋.
  ```bash
  kubectl -n platform create secret generic backoffice-secrets \
    --from-literal=KEY=VALUE ... --dry-run=client -o yaml \
    | kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller --format yaml \
    > k8s/backoffice-sealedsecret.yaml
  kubectl apply -f k8s/backoffice-sealedsecret.yaml   # 컨트롤러가 Secret 갱신
  ```
  (기존 Secret 이 SealedSecret 소유가 아니면 한 번 `kubectl -n platform delete secret backoffice-secrets` 후 재적용해 소유권 이관.)
- **DR 복구**: 새 컨트롤러 설치 → 백업한 master key 적용(`kubectl apply -f sealed-secrets-master.key.yaml` 후 컨트롤러 재시작) → `kubectl apply -f k8s/backoffice-sealedsecret.yaml`.

## 9. MiniMax Stage Agent (단계별 AI)

각 라이프사이클 단계에 AI 에이전트를 배치. **AI 는 GitHub 에 직접 쓰지 않고** `AiDraft` 초안만 만든다 → 사람이 검토/수정 → 1클릭 커밋(이슈 생성/코멘트) → webhook 으로 미러 수렴.

- **모델**: MiniMax-M3 (OpenAI 호환 `/chat/completions`, gemini-pr-bot 과 동일 플랫폼 키).
- **활성 조건**: `FEATURE_MINIMAX_ENABLED=true` AND `MINIMAX_API_KEY` 비어있지 않음(`env.minimaxConfigured()`).
- **키 출처/회전**: gemini-pr-bot 의 `seori-pr-bot-provider-secrets`(apps ns) 와 동일 값. backoffice 는 `backoffice-secrets`(platform ns)에 복제 보관(SealedSecret).
  ```bash
  # apps ns 키를 platform/backoffice-secrets 스코프로 raw 봉인 → SealedSecret 의 MINIMAX_API_KEY 항목 교체 → apply
  VAL=$(kubectl -n apps get secret seori-pr-bot-provider-secrets -o jsonpath='{.data.MINIMAX_API_KEY}' | base64 -d)
  printf '%s' "$VAL" | kubeseal --raw --namespace platform --name backoffice-secrets \
    --controller-namespace kube-system --controller-name sealed-secrets-controller
  # 출력 암호문을 k8s/backoffice-sealedsecret.yaml 의 MINIMAX_API_KEY 에 넣고 kubectl apply
  ```
- **에이전트(현재)**: 기획(`PLANNING_SPEC`, `/plan` AI 버튼→폼 채움), 분해(`TASK_BREAKDOWN`, 앱 상세→대상 이슈 코멘트), 릴리스노트(`RELEASE_NOTES`, 앱 상세→새 이슈+`release-notes` 라벨). 코드 작성은 하지 않음(자율 Claude routine 담당).
- **스키마**: `ai_draft` 테이블(마이그레이션 `1_ai_draft`). DRAFT→COMMITTED/DISCARDED.
