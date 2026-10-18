# Play 승격의 최신 제어 경로와 불변 빌드 결합

- 승인 설계: [design.md](design.md), 사용자 “둘다 진행”.
- 범위: 기본 브랜치 계약 조회·dispatch ref만 수정. AC1~3은 설계와 동일.
- 테스트: [test-plan.json](test-plan.json), L1/dev, 실패 선행 배선 검사·정확한 태그 경계 검사·typecheck/lint/build·CI·교차 리뷰.
- 중앙 의존성: seorilabs/.github#271. 13개 앱은 caller 권한 PR만 반영하며 마켓 배포하지 않는다.
- 실행 결과·PR·병합·운영 반영은 각각 실제 근거로 기록한다.
