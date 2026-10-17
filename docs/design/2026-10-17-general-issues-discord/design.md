# 일반 이슈 등록과 Discord 운영 정비

- 승인 근거: 2026-10-17 사용자 메시지의 전체 실행 계획과 “Implement the plan” 지시.
- 대상: #478, #479. 기준: `0df8051011a9e1e81db7822f34e0ae5beb02ed6b`.
- 완료 범위: Ready PR·검증·병합, Backoffice web·service 운영 배포, Discord 명령 교체와 기존 채널 이름·설명·순서 적용, 실제 조회·일반 초안 생성·취소 확인.
- 개별 제품 출시·배포는 실행하지 않는다. 채널·웹훅·권한·카드 식별자와 이력을 보존한다.

## 동작

웹 `/work/issues/new`: 앱·요청 입력 → Claude 제목·Markdown 본문 생성 → 검토·수정 → 등록 결과. 앱 작업 공간에서 앱을 미리 선택한다. 대상 앱과 저장소를 매 단계 표시한다. 실패 때 입력을 보존하고 결과 불명확 상태는 재등록 대신 조회한다.

Discord `/issue create app`: 입력창 → 대상·초안 카드 → 수정·이슈 등록·취소. 기존 `AiDraft`에 `GENERAL_ISSUE`를 추가하고 공통 서비스로 생성·편집·등록·취소한다. 제목 120자, 본문·요청 4,000자를 서버에서 검사하며 자르지 않는다. 확정하지 않은 사실·구현 범위·기획/버그/자동 처리 라벨을 추가하지 않는다. 이슈 등록은 앱 단계·구현·배포를 변경하지 않는다.

일반 이슈의 생성·편집·등록은 현재 DB의 ADMIN 또는 앱 OWNER인 MAINTAINER, 초안 작성자, 실제 앱·저장소 결합을 확인한다. Discord는 기획 또는 버그 작성 역할과 연결된 GitHub 계정의 앱 권한을 함께 확인하고 연결된 계정 ID를 초안·작업에 고정한다. 워커 실행 직전 현재 계정 연결·역할·앱 권한을 다시 확인한다. 기존 초안 등록 claim·추적 표식·결과 재조회·미러·감사를 재사용한다. 편집과 등록의 경합은 상태·claim·수정시각 조건으로 방지한다.

명령의 단일 정의에서 등록 명세·경로 해석·도움말·권한·지연 응답 여부를 파생한다. `/help`, `/account connect`, `/app status|metrics|report|reviews|keywords|health|insights`, `/issue create|plan|bug|approvals|urgent`, `/release create|deploy|snapshot`, `/note save|index`, `/chat ask|reset`만 새 명령으로 등록한다. 기존 실행 operation과 카드 ID는 유지한다. 명령 시작은 기존 backoffice ID의 운영명령 채널로 한정한다.

채널은 승인 계획 표의 한국어 이름·카테고리·순서를 사용한다. 기존 ID·알림 내부 키·권한을 보존한다. `general`, `test`는 제외한다. 관리자 세션이 확인된 경우에만 채널을 변경하며 봇 권한을 추가하지 않는다.

## 검증

같은 폴더 `test-plan.json`: L3·dev·UI 독립 검수 3회. 요구사항 실패 테스트 후 구현한다. 권한 회수·계정 해제·작성자 불일치·중복·편집 경합·통신 실패·결과 불명확·재조회·기존 기획/버그·전체 명령·자동완성·도움말·알림 목적지를 검사한다. 실제 개발 서버와 격리 DB, 가짜 외부 쓰기 경계로 이슈 생성까지 재현한다. 작은 화면·큰 글자·키보드·오류·빈 상태·완료를 실행한다. 독립 검수자는 회차별 사전 계획·실행·증거·판정을 남긴다. 실제 외부 연결 검증은 운영 조회·비민감 초안 생성·취소로 제한한다.

전체 회귀, typecheck·lint·build·작업기 번들·마이그레이션 안전 검사·중앙 검증기와 읽기 전용 Claude 교차 리뷰를 수행한다. 전체 기능 목록의 실행 불가 항목은 통과로 처리하지 않는다.

## 적용·복구

`FEATURE_GENERAL_ISSUES_ENABLED` 기본 false. 스키마는 enum 끝에 값만 추가한다. 호환 이미지로 웹과 관련 worker를 모두 갱신한 뒤 기능을 켠다. 명령·채널 적용 전 원본을 저장하고 적용 후 API/UI로 ID·이름·권한·알림 목적지를 대조한다. 장애 때 진입점을 끄고 저장한 명령·채널 구성을 복원한다. 스키마·초안은 보존하고 확장 enum을 읽을 수 있는 이미지를 유지한다.

공식 규격: [명령과 중첩 입력](https://docs.discord.com/developers/interactions/application-commands), [초기 응답·후속 응답](https://docs.discord.com/developers/interactions/receiving-and-responding).
