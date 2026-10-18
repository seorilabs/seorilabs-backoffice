# 독립 검수2회차 — 보고서 품질

결과: **보완 필요1건(R2-01)**. 실제 자료·본문·7/28일·CSV·버튼·좁은 화면의 핵심 읽기는 통과했습니다.

- 후보: `837c238310f66520d5655a9b72ef14289b164714`
- 검수자: 작성자와 다른 `review_report`
- 시작: 2026-10-17T14:39:09.263152+00:00 / 종료: 2026-10-17T14:44:03.933292+00:00
- 환경: 격리 MySQL/webpack 개발 웹/전용 Edge·공용 Playwright. 운영 DB 변경·운영 발송 없음.

## 실제 자료와 읽기

21앱·111조합·864관측에서111행·112개28일 시점을 원본과 전수 대조했습니다. CSV UI 다운로드는 발행 snapshot CSV와 byte까지 같습니다. Discord multipart의 실제 첨부는1000×730 PNG이며 생성 파일과 동일합니다. 본문은 최대3개 비교, 웹은 중요4개와 전체111행을 보존합니다. 같은 날짜·앱·국가·검색어의 기존 상세 화면까지 실제 이동했습니다.

밝음/어두움 Discord 표시 모형과390px/큰 글자를 실제 Edge에서 읽었습니다. 본문과 버튼은 잘리지 않습니다. 웹 핵심 결론·숫자·국가·검색어는390px에서 읽히고 큰 글자는 줄바꿈과 세로 스크롤로 보존됩니다. 상세 그래프와 표만 내부 가로 스크롤을 사용합니다.

읽는 사람은 행복농장KR상위20 이탈(20→28), 루시드체스US상위100 이탈(88→105), 삼국지KR상위100 진입(140→68)을 구별할 수 있습니다. 전일 비교와7일 흐름이 근거이고, 검색 유입·매출 증가를 주장하지 않으며 불필요한 행동을 만들지 않습니다.

## R2-01 — 압축 그래프의 상태 라벨 겹침

합성 경계 자료 `outside→missing→ranked→invalid→ranked→ranked→outside`에서 점 간격은 약63px입니다. 압축 이미지의 ‘목록 밖’과 바로 다음 ‘미수집’ 글자가 겹쳐 붙습니다. 상세 그래프는 정상입니다. 실제 snapshot의 주요3개에는 이 상태 조합이 없었지만 발송 대상이 될 수 있는 유효한 자료입니다.

근거: [boundary-fixture-discord.png](boundary-fixture-discord.png), [boundary-fixture.png](boundary-fixture.png), [browser-boundary-result.json](browser-boundary-result.json). 상태를 겹치지 않는 표기로 나누고3회차에서 다시 확인해야 합니다.

## 증거와 한계

- [review-result.json](review-result.json), [source-comparison-result.json](source-comparison-result.json)
- [실제 Discord 압축PNG](actual-report.png), [어두운390px 표시](discord-dark-390.png), [큰 글자 표시](discord-light-390-large.png)
- [웹390px](actual-web-viewport-390.png), [웹 큰 글자](actual-web-viewport-390-large.png), [28일 전체](actual-web-desktop-28.png)
- [동일 기준일 상세](actual-web-detail-same-day.png), [실제 발행 payload](discord-payload.json)

첫 브라우저 실행과 후속 확인에는 선택자/비동기 이동/Next 재렌더/SVG 텍스트API 도구 오류가 있었고 원본 실패를 보존했습니다. 통과했던 제품 확인은 반복하지 않고 미완료 항목만 이어서 실행했습니다. 제품 수정과 제품 실패의 무제한 재시도는 하지 않았습니다.

실제 Discord 자체 UI 도착은 이 회차에서 확인하지 않았습니다. 표시 모형과 운영 UI를 구별합니다. 검수 환경에 공개 검색용21앱을 추가하여 R3의 전체 순위행 기대값은121개입니다. 웹 서버는 다음 회차에 인계하고 전용 브라우저는 반납합니다.
