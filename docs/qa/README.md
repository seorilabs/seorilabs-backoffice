# Backoffice 개발 검수 범위

`feature-inventory.json`은 현재 구현된 사용자 흐름과 서비스 책임 42개를 관리한다. URL별 복제 메뉴와 비활성 공급자도 범위에서 숨기지 않는다. `core`는 BO-OPS-20261008-v1의 독립 UI 검수 대상이며 나머지도 배포 전 E2E 연결 대상이다.

## 배포 직전 실행 계획

- 사용자 승인: 2026-10-09 “배포, 마이그레이션, 활성화, 디스코드 명령등록 까지 진행해.”
- 제품 후보: main의 정확한 SHA. 기능 목록 추가는 실행 동작을 변경하지 않는다.
- 격리 환경: MySQL 9.2 임시 컨테이너 `backoffice-activation-qa-20261009`, localhost:33316/backoffice_qa. Next 개발 서버 localhost:3108. 공용 Playwright의 별도 root `/tmp/bo-activation-browser`, 소유 프로필 seorilabs-admin. 실제 운영 데이터와 공급자 키를 넣지 않는다.
- UI E2E: 전체 현재 페이지 및 과거 URL, 8메뉴·7앱탭, 일간 보고서 기준일/버전/빈 상태/성숙 D1·결측, 앱 운영 도구·플랫폼 조회, 근거→같은 로컬 초안, 모바일 입력/큰 글자/메뉴 초점.
- 서비스 E2E: 격리 DB에서 신호→대기열→lease→분석 저장→알림 처리/편집 경합, API permit 상한/회수; HTTP 인증·권한 차단 및 서버 실제 응답. 기존 기능 계약의 provider 전송·실패복구 회귀 테스트를 함께 실행해 기능 ID에 연결한다.
- 실제 외부 계정 호출·Issue 등록·마켓 업로드·배포 승인·결제/환불·법적 선언은 격리 E2E에서 수행하지 않는다. 공급자 없는 환경의 차단 응답을 공급자 성공으로 기록하지 않는다. 운영 적용 뒤 수집 결과·MiniMax 사용·Discord delivery/attachment·명령 목록은 별도 readback으로 확인한다.
- 이전 UI 검수: 1회차 FAIL·2회차 FAIL·3회차 PASS를 그대로 보존하고 해결 증거를 연결한다. 이전 후보 증거는 신규 SHA E2E로 재명명하지 않는다. 새로운 UI 수정/디버깅 회차를 시작하지 않는다.
- 검수 기록은 source 밖의 실행 산출물이며 SHA·설정 지문·실행 시간·기능별 실제 증거를 고정해 중앙 `development-evidence` draft release에 보관한다. 실제 수행 전 계획이며 완료 결과가 아니다.

기존 계획과 실제 증거는 [승인 설계](../design/2026-10-08-operations-insights/design.md), [독립 검수 이력](../design/2026-10-08-operations-insights/validation.md), [적용·복구](../design/2026-10-08-operations-insights/activation.md)를 따른다.

## 추가 검수 제안 — 광고 비활성 상태

정확한 main 후보 개발 E2E에서 `/platform/ads`가 연결 비활성 시 `createPlatformReadClient` 예외를 화면 밖으로 던져 HTTP 500이 되는 기존 결함을 관측했다. 기존 `platformReadConfiguration` 검사와 동일 안내를 재사용해 연결을 사용할 수 없으면 광고 관리 제목·상태 안내를 표시하고 DB/공급자 조회는 수행하지 않는 것으로 수정한다. 계정·권한 검사와 활성 연결의 동작은 유지한다. 새 메뉴·데이터·외부 write는 없다.

품의 범위는 독립 UI 추가 4회차 1회, 이후 별도 before-build/before-deploy E2E다. 동일 격리 dev3108·MySQL9.2·소유 Playwright 탭, desktop/mobile·큰 글자·비활성 안내 및 기존 종합 현황/입력 회귀를 확인한다. 예상 10~15분, 기존 로컬/CI 자원만 사용하며 유료 공급자 호출은 없다. 거부 시 실제 E2E 실패가 남아 운영 배포는 중단된다. 승인 전 추가 UI 회차를 시작하지 않는다.
