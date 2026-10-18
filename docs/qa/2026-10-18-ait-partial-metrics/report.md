# 앱인토스 부분 지표 저장 검증

- 변경 근거: [설계와 인수조건](../../design/2026-10-18-ait-partial-metrics/design.md), [#485](https://github.com/seorilabs/seorilabs-backoffice/issues/485).
- 범위: 구현·개발 환경 검증·PR·병합. 운영 migration·배포·재수집은 수행하지 않는다.
- 데이터: 이번 작업에서 만든 loopback MySQL 9.2 임시 컨테이너와 합성 App만 사용. 운영 OAuth/DB/Discord에는 시험 쓰기가 없다.

## 테스트 우선과 작성자 검증

AC-1의 IOS 광고/결제 부재 입력에서 정상 지표까지 제외되어 `days.length`가 0인 것을 먼저 확인했다. mapper 회귀 3개가 0 != 1로 실패한 뒤 정상 지표는 반환하도록 고쳤다. 이후 mapper 5개와 저장 안전 7개가 통과했다.

추가 집중 검증 55개: OS 원본 병합·명시 0·미확인 합계·특수 키·부분 카드/표 렌더·관측 원장·기존 지표 판정·기간 집계가 통과했다. 실제 HTTP MCP→수집 서비스→격리 MySQL→14개 리스팅 재조회는 전체 응답, IOS/결제 부재 상태의 NULL·세션 보존, 후속 OS/결제 복구와 기존 값 보존, 중복 잠금·재시작·재인증 차단까지 통과했다.

- `pnpm typecheck`: 통과.
- `pnpm lint`: 통과. 기존 `release-tag-ledger.test.ts`의 미사용 변수 경고 1개는 이번 변경 밖이다.
- 더미 DB의 `pnpm build`, `pnpm build:scripts`: 통과.
- `scripts/check-migration-safety.test.sh`, `scripts/check-migration-safety.sh`: 통과.
- 실제 MySQL 신규 migration과 Prisma schema diff: 일치. 테이블/열/색인/외래키 개수는 기존과 동일하며 nullable/default 계약만 바뀐다.

첫 전체 회귀는 구 동작을 기대한 MCP 테스트 1개가 실패했다(1796 통과). 부분 응답에서도 정상 지표를 반환하는 새 계약으로 기대값을 수정하고 집중 MCP 회귀 64개를 통과했다. 최초 서비스 fixture 검증은 과거 overlap의 새 부분 행과 기준일 변경을 기대값에 반영하지 못해 실패했다. 실제 DB의 새 부분 행을 보존한 채 기존 날짜 값 보존과 새 기준일을 따로 확인하도록 수정했고 최종 서비스 흐름은 통과했다.

## 독립 검증과 남은 단계

최종 커밋의 전체 회귀·서비스 흐름·이전 migration의 0/비영값 보존·실제 Chromium 표시를 별도 실행자가 재검증한다. 정확한 후보 SHA의 실행 기록과 교차 리뷰 원문은 PR에 연결한다. 준비 상태를 독립 실행 성공으로 간주하지 않는다.

결측과 부분 저장은 계속 구분한다. 일부 값이 저장되어 최신 행 날짜가 전진해도 전체 수집 완료가 아니며, 기존 collector의 partial 종료 상태도 유지한다. 운영 배포는 별도 범위이고 중앙 배포 검증기·백업/복원·운영 readback은 아직 수행하지 않았다.
