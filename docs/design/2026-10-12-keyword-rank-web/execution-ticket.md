# 검색 순위 웹 구현 실행 티켓

- 설계: [BO-KEYWORD-WEB-20261012-v1](design.md), 승인 SHA `0e06a68ee97af727638040803a080d51ebb33231`.
- 사람 승인: 2026-10-12, 기존 DB 기록을 연결해 설계 v1 구현·검증·PR 작성.
- 진행 범위 추가 승인: 2026-10-13 KST, “배포까지 쭉 진행해”. PR 리뷰·머지·운영 배포와 적용 후 확인까지 진행한다.
- 공개 이슈: [#459](https://github.com/seorilabs/seorilabs-backoffice/issues/459), 별도 공개 생성 승인 확인.
- 구현 브랜치: `feature/keyword-rank-web`, 기준 `f768239`.
- 범위: 인증된 `/feedback/keywords`, 앱·국가·기준일·7/30/90일, 최대 네 검색어 그래프, 기존 전체표·앱별 피드백 연결, 읽기 전용 관측/수집 시도 구분. 신규 스키마나 수집·운영 설정 변경 없음.
- 순서: 행동 실패 테스트 → 구현 → 독립 UI 세 회차 → 최종 SHA 전체 기능 E2E → 중앙 검증기 → typecheck/lint/build → 한국어 Ready PR·CI·적용되는 교차 리뷰.
- 검수 근거와 실패 이력: [validation.md](validation.md). 운영 배포는 현재 workflow의 명시적 실행으로 수행하며, 실제 이미지·source SHA·준비 상태와 기존 DB 조회를 확인한다. 마켓 제출·공개나 수집 일정 변경은 포함하지 않는다.
