# 리뷰 수집 수정의 개발 검증

설계와 테스트 계획: ../../design/2026-10-19-store-review-eligibility/.

기준 코드 7644fc4b59b302127547c722205cd6762846f98c에 새 회귀 사례를 적용했을 때 11개 중 6개가 동작 차이로 실패했다. tdd-red.txt에 실행 출력 앞부분을 보존했다. 수정 뒤 기존 리뷰 API, fingerprint와 알림 테스트를 포함한 20개가 통과했다.

명령: `pnpm exec tsx --test src/lib/store-reviews/*.test.ts`.

격리된 메모리 관측 저장소와 고정 리뷰 fixture를 사용하는 실제 collectStoreReviews 서비스 실행이다. 테스트는 운영 DB, 스토어 쓰기 API, Discord 전송 API를 호출하지 않는다. 최초 기준선, 다른 단계의 앱, 비활성 대상, 잘못된 복구 범위, 기존 기준선의 복구, 동일 알림 재시도, enqueue 실패와 일반 수집 재시도를 검증한다.

첫 복구가 다른 과거 리뷰의 기준선을 앞당기지 않는 사례는 첫 실패 확인 뒤 추가했다. 첫 red 로그의 11개와 최종 테스트 수의 차이는 이 추가 검증 때문이다. 교차 리뷰 뒤 상태 표 판정, enqueue 성공 뒤 markNotified 실패, 수정 리뷰 복구를 추가해 세 실패를 확인했고 review-red.txt에 남겼다. 추가 수정 후 관련 테스트 23개가 통과했다.

최종 후보 SHA의 실행 시각과 실행 로그는 소스 밖의 development-evidence와 PR 검증 기록에 결합한다. 운영 복구 결과는 개발 검증과 분리해 Issue #515에 기록한다.

두 번째 리뷰의 수정 리뷰 markNotified 실패도 재현했다. review-2-red.txt의 실패를 확인한 뒤 대기 중인 hash의 판정을 null에서 내용 불일치까지 넓혔으며, 관련 테스트 24개가 통과했다. 추가 리뷰는 요청하지 않는다.
