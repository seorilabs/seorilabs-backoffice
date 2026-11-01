# 구글플레이·앱스토어 카테고리 앱 순위 수집과 슬랙 공유

- 설계 버전: 1
- 상태: 승인
- 기준 소스: `b1c701ee3cdf798f9dae01c9ec4d55928aa8d929`
- 승인: 사용자가 키워드 검색 순위 외에 실제 앱 카테고리 순위 수집 및 슬랙 `#운영보고` 공유 설계를 승인했다.
- 대상 채널: 슬랙 `#운영보고` (`SLACK_CHANNEL_METRICS_DAILY_ID` / 논리 목적지 `metrics-daily`).

## 목적과 범위

검색어(키워드) 위치 순위 외에, 각 앱이 등록된 주 카테고리의 무료 인기 차트(Category Top Free Rank)를 App Store와 Google Play에서 정기 수집하고, 기존 정기 리포트와 통합하여 슬랙 `#운영보고` 채널로 공유한다.

1. **Apple App Store 수집**:
   - 앱의 `bundleId`로 주 카테고리(`primaryGenreId`)를 확인한다.
   - Apple 공식 Top Free RSS 피드(`https://itunes.apple.com/{country}/rss/topfreeapplications/limit=100/genre={genreId}/json`)에서 앱의 순위를 산출한다.
2. **Google Play 수집**:
   - 앱의 패키지명으로 `applicationCategory`를 확인한다.
   - 해당 카테고리 인기 무료 차트 웹 페이지를 조회하여 앱 패키지명의 순위를 산출한다.
3. **원장 저장**:
   - `MarketObservation` 테이블에 `kind: "category_rank"`로 불변 관측을 보존한다.
   - 직전 관측과의 비교(순위 변동, 진입, 이탈, 변동 없음)를 계산한다.
4. **슬랙 리포트 연동**:
   - 기존 하루 3회(08:40, 14:40, 21:40 KST) 검색 순위 리포트와 함께 카테고리 순위 요약 블록을 추가 발송한다.

## 인수조건과 검증

- **AC-1 (App Store 순위 수집)**: Apple RSS JSON 응답을 파싱하여 대상 앱의 카테고리 1~100위 순위 및 100위 밖 상태를 정확히 추출한다.
- **AC-2 (Google Play 순위 수집)**: Google Play 카테고리 무료 차트 HTML/응답을 파싱하여 대상 패키지명의 순위를 정확히 추출한다.
- **AC-3 (관측 원장 및 변동 계산)**: `MarketObservation`에 `category_rank` 관측을 기록하고, 이전 관측과 비교해 순위 변동(상승/하락/진입/이탈)을 계산한다.
- **AC-4 (슬랙 공유 텍스트)**: 기존 검색 리포트 상단에 카테고리 순위 요약을 깔끔하게 결합하여 포맷팅한다.
- **AC-5 (품질 게이트)**: `pnpm typecheck`, `pnpm lint`, `pnpm build`를 모두 통과한다.
