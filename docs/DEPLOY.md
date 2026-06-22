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
- MiniMax 활성화는 `FEATURE_MINIMAX_ENABLED=true` + `MINIMAX_API_KEY`(v2).
