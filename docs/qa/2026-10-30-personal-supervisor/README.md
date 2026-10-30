# 대표 에이전트 검증

승인 설계와 테스트 계획 커밋: `005dcba`. 실행 이슈: [#558](https://github.com/seorilabs/seorilabs-backoffice/issues/558). 실제 운영 상태와 최초 자연 승인 실행은 별도 기록한다.

- 요구사항 실패 확인: 관찰 대기를 제외하지 않아 `null !== waiting` 실패를 확인했다. 실제 MySQL의 동시 승인에서 두 번째 실행 생성이 unique constraint로 실패하는 경쟁도 재현했다.
- 수정: 관찰 대기 조건을 선별에 추가하고, 전역 행 잠금을 consistent snapshot 생성 전에 획득하도록 바꿨다. 같은 승인 두 건은 같은 runId를 돌려주고 claim 두 건 중 하나만 실행한다.
- 실행: 기존 TypeScript 자동 테스트 2,004건 통과, 전용 DB 검수 1건은 일반 테스트에서 미실행이며 실제 MySQL 8.4와 9.2에서 별도 통과했다. 기존 Python 15건과 로컬 실행기 11건 통과. 최종 후보에서는 독립 실행자가 다시 확인한다.
- 범위: 오래된 근거, 미래 시각, 표본, 대기, 중복, 버전과 해시 변경, 다른 PC, lease 만료, 취소 후 늦은 성공, 응답 유실의 같은 requestId 재전송, 다른 본문 충돌, 외부 결과 불명 시 잠금 유지와 사람 확인을 검증했다.
- 마이그레이션: 실제 MySQL 9.2 빈 DB에 전체 적용과 schema fingerprint를 확인했다. 기존 writer용 추가 컬럼은 nullable과 기본값으로 확장한다. 중앙 expand-only 검사를 약화하지 않는다.
- 브라우저: 전용 DB와 실제 Auth.js JWT를 사용했다. 인증을 끄는 경로는 만들지 않았다. 390px 화면에서 미리보기, 승인 버튼과 가로 넘침을 확인했다. Next 개발 연결의 로컬 origin과 HMR 인증 충돌을 고쳐 실제 hydration을 확인했다.
- 실제 CLI 인증, provider 쓰기, 운영 Slack 발송, 배포와 LaunchAgent 실행은 위 격리 검수와 구분한다. 가짜 CLI와 테스트 원고를 최초 자연 관측이나 실제 사용자 승인으로 표시하지 않는다.

독립 검수 3회와 중앙 검증, MiniMax 리뷰 및 운영 읽기 결과는 실행 후 추가한다. 원본 로그와 PNG는 NAS 검증 절차로 이관하고 위치와 해시를 남긴다.

## 예비 독립 검수와 수정

원래 후보 `3f04012`의 독립 실행에서 만료 heartbeat의 복구 차단, 첫 커밋이 없는 원고 작업 공간, CLI leader가 끝난 뒤 남는 자식 쓰기, claim 응답 유실을 재현했다. 후속 예비 실행에서 취소와 claim 응답 유실이 겹친 분기도 재현했다. 실패 원본은 지우지 않았다. 공식 UI 검수는 이 예비 실행에 포함하지 않는다.

수정은 구조화된 거절 응답, 거절 원본 보존 후 프로세스 그룹 중단과 실행 재조회, 빈 HEAD 처리, 같은 claim 식별자의 멱등 처리, CLI 시작 전 서버 체크포인트, 실행 전 취소의 중단 보고다. 로컬 회귀 11건과 실제 API, 웹 승인, 가짜 CLI subprocess, 실제 원고 해시 적용, 서버 완료 재조회가 통과했다. 개발 서버 컴파일을 마친 Slack의 거절 요청 응답은 약 0.01초였다.

초기 독립 검수의 원본 29개는 `/Volumes/Data/Backup/agent-artifacts/seorilabs-backoffice/2026-10-30/3f04012a394371971f24db5b691b919550e2950b/independent-runtime-qa-20261030T034221Z`에 보관했다. manifest SHA-256은 `74ccaf7a7e01e4875f98fa3568b21cfae229bde03a0351152e3557e28022148e`다. 후속 예비 원본 16개는 같은 후보 아래 `independent-recovery-preflight-a90ccd66-20261030T035338Z`에 보관했으며 manifest SHA-256은 `11cdbc087ffa2a78ae2c11d7b1ceb64c24f2772a73147254de7c36a5ba5fd7bd`다. 두 사본 모두 파일 직접 읽기 크기와 해시, 마지막 manifest readback을 검증했다.


후속 자체 점검에서 같은 시간대의 관측 갱신이 기존 ID와 다른 시각으로 충돌하는 실패를 재현했다. 관측 ID에는 실제 전체 관측 시각을 사용하고 문제 식별자는 유지했다. 근거 링크의 실제 페이지 존재도 검사해 `/settings/health`로 고쳤다. 새 Python 회귀를 포함한다. 기존 ChatGPT 로그인과 실제 Codex CLI에서 빈 후보 JSON schema 응답 및 정확한 세션 ID를 확인했다. 이는 연결 검수이며 자연 제안이 아니다. MiniMax 1회차를 처리했으며 수정 확인은 600초 제한으로 중단됐다. 그 결과를 통과로 표시하지 않고 최대 회차 규칙에 따라 자체 점검과 독립 실행으로 진행한다.
