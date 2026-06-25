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

## 10. 빌드 캐시 — 영구 BuildKit 빌더 (CI 의존성)

CI(`deploy.yml`)의 `build` 잡은 ARC ephemeral 러너에서 돌지만, **클러스터 내 영구 BuildKit 데몬**(`k8s/buildkitd.yaml`, platform ns, rpi4001)을 remote 빌더로 사용한다. 캐시(pnpm store·`.next/cache`·레이어)가 PVC `buildkit-cache`(25Gi)에 지속되어 **증분 빌드**가 가능하다.

- **효과(실측)**: 콜드 ~33분 → 의존성 무변경/캐시히트 ~3분, 일반 코드 변경 ~15–18분.
- **연결**: `deploy.yml` 의 `setup-buildx-action(driver: remote, endpoint: tcp://buildkitd.platform.svc.cluster.local:1234)`. 러너(arc-runners ns)는 platform ns ClusterIP 로 접속. `next build` 는 `eslint.ignoreDuringBuilds`/`typescript.ignoreBuildErrors`(verify 잡이 게이트)로 중복 제거.
- **메모리**: buildkitd limit **5Gi**, `next build` 는 Dockerfile `NODE_OPTIONS=--max-old-space-size=2048` 로 힙 상한(증분 시 `.next/cache` 로드로 메모리 피크↑ → OOM(exit 137) 방지). 제어플레인 노드라 한도 상향은 보수적으로.
- **장애 시**: buildkitd 가 죽으면 **모든 빌드 실패**. 복구 `kubectl apply -f k8s/buildkitd.yaml`. 캐시는 PVC 라 재시작에도 유지. 캐시 비우려면 `kubectl -n platform exec deploy/buildkitd -- buildctl prune`.
- **주의**: `buildkitd.yaml`/CronJob 등 매니페스트 변경은 CI(`set image`)로 반영 안 됨 → `kubectl apply` 1회 필요.

## 11. Vault RAG — Obsidian 볼트 지식 + 벡터검색 + 받은함 쓰기

Syncthing(`data` ns, hostPath `/data/syncthing`, rpi5)이 동기화하는 **Obsidian 메인 볼트**(`Sync/obsidian-main`, .md ~1.2k)를 MiniMax 지식 원천으로 인덱싱한다. PVC(`syncthing-pvc`, RWO, `data` ns)는 네임스페이스 스코프라 `platform` 의 backoffice 가 직접 못 붙는다 → **인덱서/라이터는 `data` ns CronJob**(같은 rpi5, RWO 동시 마운트), backoffice 는 **MySQL `vault_chunk` 만 조회**.

```
data ns                                   platform ns
 vault-indexer CronJob (2h)                search_knowledge 챗 도구(MiniMax 자동 호출)
   PVC ro → chunk → gemini-embed →         /api/admin/vault/probe  (임베딩 실측, 키 비노출)
   vault_chunk(embedding LONGBLOB)         /api/admin/vault/search (검색 점검)
 vault-writer CronJob (5m)                 enqueueVaultWrite → vault_write_request
   PENDING 드레인 → 받은함/*.md (uid 1000)   (텔레그램 /save)
```

- **임베딩**: **Google Gemini `gemini-embedding-001`**(`:batchEmbedContents`, 1536dim, taskType RETRIEVAL_DOCUMENT/QUERY 비대칭). MiniMax 국제(.io)는 임베딩 미제공이라 별도 제공자 사용 — **챗/추론은 그대로 MiniMax-M3**. 벡터는 ANN 인덱스(HeatWave 전용) 없이 **float32 LONGBLOB 저장 + 앱 brute-force cosine**(cosine 은 스케일 불변이라 정규화 불필요). 검색측은 임베딩만 메모리 캐시(시그니처 변하면 갱신).
- **인덱싱 범위 = 최상위 폴더 allowlist** `VAULT_INCLUDE_DIRS=프로젝트,지식,받은함,자료`(+`.obsidian` 등 메타 제외). ⚠️ **블록리스트 금지 교훈**: 볼트에 시크릿(니모닉·access key·kubeconfig)이 `보관함/EpicLeague/Keep/` 등 `비공개` 아닌 폴더에도 흩어져 있어 "비공개만 제외" 시 Gemini/MiniMax 로 유출됨 → **화이트리스트로 전환**. 증분(파일 sha256 == DB fileHash 면 스킵), allowlist 밖 기존 청크는 인덱서 삭제 로직이 자동 purge.
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
6. 검색 점검: `curl -XPOST -H "x-admin-token: $TOK" -d '{"q":"게임 아이디어"}' .../api/admin/vault/search`. 텔레그램에서 `/save 테스트 메모` → 5분 내 받은함에 파일.

> **주의**: `vault-rag.yaml`·`deployment.yaml` env 변경은 CI(`set image`) 비대상 → `kubectl apply` 1회. Gemini 무료등급(임베딩 RPD/TPM) 고려해 인덱서는 2h 주기(증분이라 대부분 스킵).
