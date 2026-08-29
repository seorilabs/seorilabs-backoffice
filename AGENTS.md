# AGENTS.md — seorilabs-backoffice 협업 가이드

## 원칙
- 한글을 주 언어로. 간결·실무적으로.
- GitHub = source of truth. 이 앱 DB 는 미러 + 라이프사이클 상태. 미러를 GitHub 로 역기록하지 않는다(단방향).
- 모든 쓰기는 `GitHub API → webhook → 미러 upsert` 로 수렴. 미러 테이블에 직접 INSERT 금지(서버 액션도 GitHub write 후 미러).

## 품질 게이트 (PR 전 필수)
```bash
pnpm typecheck
pnpm lint
pnpm build          # DATABASE_URL 더미로 OK (빌드 시 DB 미접속)
```

## 구조
- `prisma/schema.prisma` — 데이터 모델(미러 + 라이프사이클). v2 모델은 비파괴 add 로만.
- `src/lib/github/*` — App 인증, webhook 검증, write.
- `src/lib/sync/*` — 미러 upsert, backfill/reconcile, 전이 엔진.
- `src/lib/seed/registry.ts` — 레포 스캔 시드(type/engine 분기, .example.json=미설정).
- `src/lib/actions/*` — 서버 액션(전이/이슈/승인/리싱크).
- `src/app/(app)/*` — 인증 보호 화면. `src/app/login` — 공개.
- `src/app/api/{webhooks,auth,health,metrics,admin}` — 라우트.
- `k8s/` — 매니페스트. `docs/DEPLOY.md` — 운영 런북.

## 규칙
- PR 은 Ready(Draft 금지), 제목/본문 한글. `Closes #N`.
- GitHub Actions action 은 `global-versions.yaml` 기준 최신 stable 태그.
- 배포는 ARM64. 이미지는 hosted 러너에서 `BUILDPLATFORM` 크로스빌드한다. Deploy 의
  `verify`/migration contract/`deploy` 는 ARC 에 남아 hosted 결제와 무관하게 시작한다.
- **PR 트리거 잡은 반드시 GitHub-hosted(`ubuntu-latest`)** — public 저장소라 fork PR 코드가
  ARC 에서 돌면 클러스터 내부 네트워크에 닿는다. self-hosted 는 `push`/`workflow_dispatch`
  전용 잡에만 쓴다.
- 라이프사이클 자동 전이는 deploy `workflow_run` 성공만. 라벨/마일스톤 기반 자동 전이 금지(게임 레포 호환).
