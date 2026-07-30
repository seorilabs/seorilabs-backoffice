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
  --from-literal=GEMINI_API_KEY=''
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
- Gemini Stage Agent는 `FEATURE_GEMINI_ENABLED=true` + `GEMINI_API_KEY`(§9).

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

## 10. 빌드 캐시 — 영구 BuildKit 빌더 (CI 의존성)

CI(`deploy.yml`)의 `build` 잡은 ARC ephemeral 러너에서 돌지만, **클러스터 내 영구 BuildKit 데몬**(`k8s/buildkitd.yaml`, platform ns, rpi4001)을 remote 빌더로 사용한다. 캐시(pnpm store·`.next/cache`·레이어)가 PVC `buildkit-cache`(25Gi)에 지속되어 **증분 빌드**가 가능하다.

- **효과(실측)**: 콜드 ~33분 → 의존성 무변경/캐시히트 ~3분, 일반 코드 변경 ~15–18분.
- **연결**: `deploy.yml` 의 `setup-buildx-action(driver: remote, endpoint: tcp://buildkitd.platform.svc.cluster.local:1234)`. 러너(arc-runners ns)는 platform ns ClusterIP 로 접속. `next build` 는 `eslint.ignoreDuringBuilds`/`typescript.ignoreBuildErrors`(verify 잡이 게이트)로 중복 제거.
- **메모리**: buildkitd limit **5Gi**, `next build` 는 Dockerfile `NODE_OPTIONS=--max-old-space-size=2048` 로 힙 상한(증분 시 `.next/cache` 로드로 메모리 피크↑ → OOM(exit 137) 방지). 제어플레인 노드라 한도 상향은 보수적으로.
- **장애 시**: buildkitd 가 죽으면 **모든 빌드 실패**. 복구 `kubectl apply -f k8s/buildkitd.yaml`. 캐시는 PVC 라 재시작에도 유지. 캐시 비우려면 `kubectl -n platform exec deploy/buildkitd -- buildctl prune`.
- **주의**: `buildkitd.yaml`/CronJob 등 매니페스트 변경은 CI(`set image`)로 반영 안 됨 → `kubectl apply` 1회 필요.

## 11. Vault RAG — Obsidian 볼트 지식 + 벡터검색 + 받은함 쓰기

Syncthing(`data` ns, hostPath `/data/syncthing`, rpi5)이 동기화하는 **Obsidian 메인 볼트**(`Sync/obsidian-main`, .md ~1.2k)를 Gemini 지식 원천으로 인덱싱한다. PVC(`syncthing-pvc`, RWO, `data` ns)는 네임스페이스 스코프라 `platform` 의 backoffice 가 직접 못 붙는다 → **인덱서/라이터는 `data` ns CronJob**(같은 rpi5, RWO 동시 마운트), backoffice 는 **MySQL `vault_chunk` 만 조회**.

```
data ns                                   platform ns
 vault-indexer CronJob (2h)                search_knowledge 챗 도구(Gemini 자동 호출)
   PVC ro → chunk → gemini-embed →         /api/admin/vault/probe  (임베딩 실측, 키 비노출)
   vault_chunk(embedding LONGBLOB)         /api/admin/vault/search (검색 점검)
 vault-writer CronJob (5m)                 enqueueVaultWrite → vault_write_request
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
6. 검색 점검: `curl -XPOST -H "x-admin-token: $TOK" -d '{"q":"게임 아이디어"}' .../api/admin/vault/search`. 텔레그램에서 `/save 테스트 메모` → 5분 내 받은함에 파일.

- **즉시 재인덱싱 트리거**: 텔레그램 `/index` 또는 `POST /api/admin/vault/reindex` → backoffice 가 K8s API 로 `data` ns 에 인덱서 Job 생성(`src/lib/k8s/vault-trigger.ts`, 파드 SA 토큰+CA, 의존성 0). 실행 중이면 중복 방지, 완료 후 ttl 자동 정리. 평소 2h 자동 증분과 별개로 "방금 쓴 문서 바로 검색" 용도. RBAC: `k8s/vault-trigger-rbac.yaml`(SA `backoffice` + data ns Role: cronjobs get, jobs create/list/get), deployment `serviceAccountName: backoffice`.

> **주의**: `vault-rag.yaml`·`deployment.yaml`·`vault-trigger-rbac.yaml` 변경은 CI(`set image`) 비대상 → `kubectl apply` 1회. 임베딩은 Gemini 결제 키(Tier 1)라 throttle 무관. 증분은 변경 파일만 임베딩(비용 거의 0).

## 12. 출시노트 (Release Notes) — 태그 diff 기반 8개 언어 유저 공지

릴리즈 태그(`v*`) push 시 **이전 릴리즈 태그~새 태그**의 변경(머지 PR/커밋)을 GitHub compare 로 모아 Gemini로 **사용자용 출시노트(ko_KR/en_US/ja_JP/zh_CN/zh_TW/de_DE/fr_FR/es_ES)** 를 생성, `release_note` 테이블에 저장한다. 백오피스 `/release-notes`(전역 타임라인) + 앱 상세 "출시노트" 섹션에서 언어별로 전문을 열람할 수 있고, `Android용 전체 복사`로 Google Play Console의 `<ko-KR>...</ko-KR>` 일괄 입력 형식을 복사할 수 있다.

태그와 GitHub Release 생성은 번역을 기다리지 않는다. tag push webhook 응답 이후 Next.js `after` 작업이 번역을 생성하고 GitHub Release 본문과 `release-notes.json` 에셋을 갱신한다.

```mermaid
flowchart LR
  TAG["태그 push refs/tags/v*"] -->|webhook 200| AFTER["Next.js after"]
  AFTER --> GEN["generateAndPublishReleaseNotes"]
  GEN --> CMP["compareCommitsWithBasehead(prev...new)"] --> AI["Gemini → JSON 8개 언어"] --> DB[("release_note")]
  DB --> UI["/release-notes + 앱상세"]
  DB --> GH["GitHub Release 본문 + release-notes.json 갱신"]
```

- **트리거(자동)**: webhook `push` + `created` + `ref=refs/tags/v*`. **⚠️ GitHub App 이 `push` 이벤트를 구독해야 자동 발화** — App 설정 > Permissions & events > Subscribe to events > **Push** 체크(미구독 시 자동 생성 안 됨, 수동 백필은 가능).
- **수동 백필/재생성**: `POST /api/admin/release-notes/generate`(x-admin-token) body `{repo, version, headSha?}`. 멱등 upsert(`@@unique([repoFullName, version])`).
- **생성 로직**(`src/lib/core/release-notes.ts`, `src/lib/github/release.ts`): `listVersionTags`(semver 내림차순) → `previousTag` → `compareTags`(머지 PR 추출: `(#N)`/`Merge pull request #N`) → `buildReleaseNotesI18nPrompt` → Gemini JSON(`parseLooseJson` 견고 파싱).
- **untagged 보정**: deploy `workflow_run` 의 head_branch 가 버전이 아니면(main 등) `findTagForSha(head_sha)` 로 태그를 조회해 ReleaseRecord.version 복원(출시 매트릭스). 태그 없으면 "untagged" 유지(연속배포).
- 마이그레이션 `6_release_note`, `14_release_note_i18n`. webhook 은 생성이 느려도 200 을 막지 않도록 Next.js `after`에서 후처리한다.

## 13. Telegram 배포 완료 알림

- `/release` 앱 목록은 GitHub 레지스트리를 서버 부팅 30초 후와 6시간마다 자동 재스캔한다. 명령 첫 줄의 `앱 목록 새로고침`으로 즉시 재스캔할 수도 있다. `game/project.godot` 레이아웃을 포함하며 한국어 마켓명·Godot명·짧은 한국어 저장소 설명을 우선 표시한다.
- GitHub 마켓 배포는 `workflow_run.completed`를 `ReleaseRecord`에 반영한 뒤 `telegram_notification` outbox에 성공·실패 알림을 멱등 큐잉한다.
- 알림에는 한글 앱명, 릴리즈 태그, 마켓, 실행 이름, GitHub Actions 실행 링크가 포함된다.
- Telegram에서 트리거한 배포는 감사 로그에 저장한 `chatId/messageId`로 기존 `/release` 메시지를 현재 버튼 상태로 다시 그린다. 원문 수정 실패는 새 완료 알림을 막지 않는다.
- Telegram API의 일시 오류는 요청 내 재시도 후 outbox가 30초 지수 backoff, 최대 30분 간격으로 재시도한다. 전송 성공·실패는 `AuditLog`의 `telegram.deploy.notification.*` action으로 확인한다.
- Xcode Cloud App Store 배포는 `ReleaseRecord.externalRunId`로 실행을 저장하고 서버 scheduler가 Node 전용 admin route를 통해 1분마다 App Store Connect `ciBuildRuns/{id}`를 조회한다. 완료 결과는 동일 outbox로 알리고 성공 시 기존 라이프사이클 전이도 실행한다.
- `lucid-chess`는 `com.etlegame.chess` Xcode Cloud 제품과 `Lucid Chess Release` workflow를 사용한다. repo의 표준 `deploy-app-store.yml`이 market target 신호를 제공하고, Backoffice allowlist가 GitHub dispatch 대신 ASC `ciBuildRuns` 경로를 선택한다.
- `cycle-pair`는 `com.seorilabs.cyclepair` Xcode Cloud 제품과 `Cycle Pair Release` workflow를 사용한다. 같은 제품에 다른 repo workflow가 남아 있어도 workflow repository가 요청 repo와 정확히 일치하는 `APP_STORE_ELIGIBLE` iOS Archive만 선택하며, 0개 또는 복수면 실행하지 않는다.
- 관련 마이그레이션: `16_deploy_completion_notifications`.

## 14. AppOps Kubernetes worker

앱별 관리 도구는 GitHub Actions를 실행기로 사용하지 않는다. 백오피스 API가
`app_operation_run`에 검증된 요청을 적재하고, 별도
`backoffice-app-ops-worker` Deployment가 게임별 최소권한 identity로 처리한다.

- 웹 Pod에는 게임 자격증명을 주입하지 않는다.
- worker 전용 Secret 이름은 `backoffice-app-ops-secrets`다.
- 도마뱀 IAP 조회 키는 `LIZARD_TYCOON_APP_OPS_SA_KEY_JSON`이며
  `lizard-tycoon` 프로젝트의 `roles/datastore.viewer`만 부여한다.
- 입력 파라미터와 결과는 24시간 뒤 제거한다. 영수증, 구매 토큰, 비밀번호, 개인키는
  요청이나 결과에 포함하지 않는다.
- worker는 처리 중 중단된 요청을 최대 세 번 재시도한다.

최초 부트스트랩은 평문 JSON을 출력하지 않고 파일 입력으로 Secret을 만든 뒤 SealedSecret으로
관리한다.

```sh
kubectl -n platform create secret generic backoffice-app-ops-secrets \
  --from-file=LIZARD_TYCOON_APP_OPS_SA_KEY_JSON=/secure/path/lizard-app-ops.json
kubectl apply -f k8s/ci-deployer-rbac.yaml
kubectl apply -f k8s/app-ops-worker.yaml
```

배포 workflow는 먼저 웹 Deployment의 Prisma migration과 rollout을 끝낸 뒤 worker
Deployment를 같은 이미지 SHA로 갱신한다. 검증은 두 Deployment의 rollout, worker 로그,
DB 요청 상태, 실제 게임 데이터 readback 순서로 수행한다.
