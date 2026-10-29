# Slack 메시지 표시 개편

사용자가 전달한 「Slack 메시지 포맷 전반 개편」과 구현 지시가 승인 근거다. 정돈된 카드와 뉴스레터형 개인피드를 새로 발송하는 메시지에 적용한다. 과거 메시지의 일괄 수정이나 재발송, 알림 선정 기준과 시간 변경은 범위에 없다.

예시: `광고 보상 지급 완료` → 앱 이름 → 보상 항목과 지급 수량 → 제공사와 한국 시각. 뉴스는 회차 제목과 기사 수 → 기사별 제목과 요약 → `원문 보기`, 기사 사이 구분선 순서다. 짧은 앱 이벤트는 한 줄을 유지한다. 결제는 실제, 테스트, 미확인을 구분한다.

공통 `presentation`은 선택형 JSON이며 title, status, fields, body, sections, items, links, context, timestamp를 받는다. 기존 text와 embed도 같은 경계에서 읽는다. `marked` lexer가 Markdown을 분석하고 Slack rich_text로 렌더링한다. 사용자 입력은 멘션 요소로 승격하지 않는다. 일반 텍스트는 접근성과 알림 미리보기에 제공한다. DB schema는 바꾸지 않는다.

전송은 메시지와 블록 길이를 계산해 나눈다. 기사는 경계에서 묶고 큰 단일 본문은 요소 경계에서 분할한다. 버튼과 첨부는 마지막 부분에 보존한다. 연속편은 기존 providerReceipt JSON에 시도와 message ID를 기록한다. 결과 불명 요청은 다시 보내지 않는다. 정상 데이터 갱신, 쓰레드, 파일 영수증과 보존 정리를 이어 쓴다.

외부 생산자 fundevel/cronjobs는 선정과 요약 모델을 바꾸지 않고 기존 제목, 요약, 링크를 전달한다. NATS v1의 text, source, id 생성 규칙과 수신 승인 후 sent 기록은 유지한다. 큰 회차는 본문 상한 안에서 기사 경계로 나눈다.

인수조건: A1 13개 목적지와 21개 명령 예제, A2 제목과 본문 구조 및 접근성, A3 길이와 버튼 및 이미지 보존, A4 재시도와 권한 및 확인 취소 회귀, A5 소비자와 생산자 계약 호환, A6 실제 Slack 일반 폭과 좁은 폭 독립 검수 3회, A7 소비자 선배포와 새 자연 알림 확인.

검수는 L3 개발 환경 전체 회귀와 독립 시각 검수 3회다. 합성 자료를 명시하며 실제 운영 명령을 실행해 이슈나 릴리스를 만들지 않는다. 최초 요구사항 테스트 4개가 기존 renderer에서 실패한 것을 확인한 뒤 구현했다. 실제 Slack 외관은 자동 단위 검사로 대체할 수 없어 독립 브라우저 검수를 사용한다.

출시 끝은 서비스 운영 반영과 새 알림의 실제 표시 확인이다. Backoffice 소비자를 먼저 배포하고 생산자를 적용한다. 복구 시 생산자부터 이전 이미지로 되돌린다. 자격증명은 기존 활성 shared/slack/backoffice-bot을 재사용한다. 증적 원본은 NAS1dual에 검증 복사 후 로컬에서 정리한다.

공식 근거: [Block Kit](https://docs.slack.dev/block-kit/), [rich_text](https://docs.slack.dev/reference/block-kit/blocks/rich-text-block/), [Marked lexer](https://marked.js.org/using_pro#lexer).
