# AGENTS.md — seorilabs-backoffice 협업 가이드

## 원칙
- 한글을 주 언어로. 간결·실무적으로.
- 사용자 화면의 메뉴·버튼·상태·안내는 쉬운 한국어로 쓴다. `Fleet`은 `앱 통합 관리`, `ConfigRevision`은 `설정 버전`, `lifecycle`은 `개발·출시 단계`로 표시한다. 내부 식별자·API·저장값은 표시 용어와 분리해 유지하고 업로드·심사·배포·공개 확인은 구분한다.
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
- **모든 CI/CD 잡은 GitHub-hosted(`ubuntu-latest`)** — self-hosted(ARC)를 쓰지 않는다.
  org 러너그룹의 "Allow public repositories" 는 해제 상태를 유지하며, 이 저장소를 위해
  켜지 않는다(그룹 단위 플래그라 다른 public 저장소까지 열린다).
- 이미지는 arm64 지만 hosted 에서 `BUILDPLATFORM` 크로스빌드한다. 배포는 공개 도달
  가능한 k8s API(`k8s.vzyx.xyz:16443`)에 kubectl 로 적용한다.
- 라이프사이클 자동 전이는 deploy `workflow_run` 성공만. 라벨/마일스톤 기반 자동 전이 금지(게임 레포 호환).
