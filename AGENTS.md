# AGENTS.md — seorilabs-backoffice 협업 가이드

## 원칙

- 한글을 주 언어로. 간결·실무적으로.
- 사용자 화면의 메뉴·버튼·상태·안내는 쉬운 한국어로 쓴다. `Fleet`은 `앱 통합 관리`, `ConfigRevision`은 `설정 버전`, `lifecycle`은 `개발·출시 단계`로 표시한다. 내부 식별자·API·저장값은 표시 용어와 분리해 유지하고 업로드·심사·배포·공개 확인은 구분한다.
- 데이터별 정본을 구분한다. GitHub는 코드·태그·Issue·PR의 정본이며, Backoffice는 중앙 운영 설정과 실행 대기열의 정본이다. DB 전체를 GitHub 미러로 취급하지 않는다.

| 데이터 | 정본과 기록 경로 |
| --- | --- |
| 코드·태그·Issue·PR | GitHub API → webhook/reconcile → 해당 미러. 미러 직접 수정이나 DB 값을 GitHub로 역기록하지 않는다. |
| stack·package·bundle·build target 등 자동 탐지 사실 | exact source SHA에 결합된 `DiscoveryObservation`. 발견이 모호하면 `needs_input`이며 운영자의 설정을 추측해 덮어쓰지 않는다. |
| 마켓·정책·자산·운영 desired state | Backoffice의 불변 `ConfigRevision`과 해당 중앙 모델. 사람 UI와 승인된 AI API가 동일 validator·service를 사용한다. |
| 마켓·클라우드의 실제 상태 | 공식 provider readback에 근거한 `ProviderObservation`. 설정값이나 workflow 성공만으로 실제 배포·공개 상태를 만들지 않는다. |
| 작업과 실행 | 대상 저장소 Issue가 작업 정본, 조직 Project는 집계 화면, Backoffice의 occurrence/run/lease/event가 실행 대기열 정본이다. Project field 변경을 claim으로 사용하지 않는다. |

- 중앙 설정 변경은 `src/lib/control-plane/`의 기존 서비스와 `/api/control-plane/` API 또는 같은 서비스를 호출하는 서버 액션을 사용한다. GitHub 변경을 선행 조건으로 만들지 않으며, SQL·직접 Prisma 호출로 validator, 앱 범위 RBAC, optimistic concurrency, idempotency, append-only audit를 우회하지 않는다. 상세 계약은 [FLEET_CONTROL_PLANE.md](docs/FLEET_CONTROL_PLANE.md)를 따른다.
- `ConfigRevision` payload는 수정하지 않고 새 revision을 만든다. `DRAFT → ACTIVE → SUPERSEDED`와 source SHA·설정 revision을 고정한 release candidate를 유지한다. AI의 비민감 설정 생성·활성화는 현행 정책 범위 안에서만 허용하며 법적 선언, 계정 소유권, 결제·세금, 심사 제출·공개 배포 승인은 사람 전용이다.
- 신규 앱 운영 JSON이나 `.seorilabs/app.yaml`·`.seorilabs/backoffice.json`을 별도 정본으로 만들지 않는다. 기존 JSON과 legacy parser·consumer는 이관 입력·비교 대상으로 보존하며 두 번 연속 shadow parity, 선언 마켓 build-only, 장애 복구 등 정리 gate 통과 전에는 삭제하지 않는다. 빌드 원본과 중앙 생성 thin workflow caller는 제거 대상이 아니다.
- Backoffice에는 credential의 logical ID, 공개 identity, fingerprint와 scope만 저장한다. secret 원본은 `~/.config/seorilabs`이며 활성 공용 identity를 앱별 대체 키로 우회하지 않는다. 실제 등록·실행이 막혀 있으면 정확한 승인·입력 gate를 기록한다.

## 품질 게이트 (PR 전 필수)

```bash
pnpm typecheck
pnpm lint
pnpm build          # DATABASE_URL 더미로 OK (빌드 시 DB 미접속)
```

## 구조

- `prisma/schema.prisma` — GitHub 미러, 중앙 설정·관측, 실행 대기열, 개발·출시 단계 모델. schema migration과 legacy 제거는 각각 기존 안전 gate를 따른다.
- `src/lib/control-plane/*` — 중앙 계약·validator·서비스·감사. `src/lib/actions/fleet-control-plane.ts`와 `/api/control-plane/*`가 같은 서비스 경계를 사용한다.
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
- 기존 deploy `workflow_run` 미러와 중앙 개발·출시 단계를 구분한다. 중앙 단계는 현행 lifecycle policy와 release gate ledger의 근거로만 전진한다. 라벨·마일스톤·Project field를 실행 claim이나 출시 증거로 사용하지 않으며 build/upload/processing/device QA/review/approval/deployment/public 상태를 합치지 않는다.
