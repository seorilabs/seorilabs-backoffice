# 대표 에이전트 검증

승인 설계와 테스트 계획 커밋: `005dcba`. 실행 이슈: [#558](https://github.com/seorilabs/seorilabs-backoffice/issues/558). 실제 운영 상태와 최초 자연 승인 실행은 별도 기록한다.

- 요구사항 실패 확인: 관찰 대기를 제외하지 않아 `null !== waiting` 실패를 확인했다. 실제 MySQL의 동시 승인에서 두 번째 실행 생성이 unique constraint로 실패하는 경쟁도 재현했다.
- 수정: 관찰 대기 조건을 선별에 추가하고, 전역 행 잠금을 consistent snapshot 생성 전에 획득하도록 바꿨다. 같은 승인 두 건은 같은 runId를 돌려주고 claim 두 건 중 하나만 실행한다.
- 실행: 기존 TypeScript 자동 테스트 2,004건 통과, 전용 DB 검수 1건은 일반 테스트에서 미실행이며 실제 MySQL 8.4와 9.2에서 별도 통과했다. 기존 Python 6건과 로컬 실행기 7건 통과. 최종 후보에서는 독립 실행자가 다시 확인한다.
- 범위: 오래된 근거, 미래 시각, 표본, 대기, 중복, 버전과 해시 변경, 다른 PC, lease 만료, 취소 후 늦은 성공, 응답 유실의 같은 requestId 재전송, 다른 본문 충돌, 외부 결과 불명 시 잠금 유지와 사람 확인을 검증했다.
- 마이그레이션: 실제 MySQL 9.2 빈 DB에 전체 적용과 schema fingerprint를 확인했다. 기존 writer용 추가 컬럼은 nullable과 기본값으로 확장한다. 중앙 expand-only 검사를 약화하지 않는다.
- 브라우저: 전용 DB와 실제 Auth.js JWT를 사용했다. 인증을 끄는 경로는 만들지 않았다. 390px 화면에서 미리보기, 승인 버튼과 가로 넘침을 확인했다. Next 개발 연결의 로컬 origin과 HMR 인증 충돌을 고쳐 실제 hydration을 확인했다.
- 실제 CLI 인증, provider 쓰기, 운영 Slack 발송, 배포와 LaunchAgent 실행은 위 격리 검수와 구분한다. 가짜 CLI와 테스트 원고를 최초 자연 관측이나 실제 사용자 승인으로 표시하지 않는다.

독립 검수 3회와 중앙 검증, MiniMax 리뷰 및 운영 읽기 결과는 실행 후 추가한다. 원본 로그와 PNG는 NAS 검증 절차로 이관하고 위치와 해시를 남긴다.
