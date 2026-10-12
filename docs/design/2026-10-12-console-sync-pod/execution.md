# 파드 콘솔 수집 실행 티켓

- 설계 ID: `2026-10-12-console-sync-pod`, [설계 v1](design.md)
- 승인 커밋: `0b929ccb1d9a6272fb0d4004056791d31e5eb35c`
- 사람 승인: 사용자, 2026-10-12 KST(정확한 시각 미확인). OAuth 검증·구현·검증·PR 승인, 운영 배포·스케줄 활성화 제외.
- 보완 승인: 사용자, 2026-10-13 KST. 대상 커밋 `46afeca806866e6ddc152d98afbeaaf555dda84e`, [인증·재시도 보완 설계](review-followup.md)와 새 최초 인가·로컬 자격증명 등록·실제 갱신·재시작 검증 승인. 운영 Secret·배포·스케줄 활성화는 제외.
- 실행 Issue: [#461](https://github.com/seorilabs/seorilabs-backoffice/issues/461). 코드 동작과 공개 인수조건만 기록한다. 상세 승인·검수는 이 파일과 설계 정본을 따른다.
- Ready PR: [#462](https://github.com/seorilabs/seorilabs-backoffice/pull/462). 운영 gate가 남아 있어 병합·배포하지 않는다.

## 문제·범위

대화형 수집을 전용 파드에서 실행할 수 있는 조회 경로를 만들고, 광고·결제 누락이 기존 값을 0으로 덮어쓰는 동작을 고친다. MiniMax는 기존 분석 경로를 사용한다. 보완 승인으로 새 콘솔 OAuth 최초 인가와 로컬 등록을 포함한다. 새 스키마·운영 Secret 적용·배포는 범위 밖이다.

## 인수조건·검증

[설계 AC-1~7](design.md#인수조건테스트검수)을 그대로 적용한다. AC-1 실제 OAuth 최초 인가·만료 갱신·파드 재시작은 등록된 자격증명 부재로 차단이다. 사용자도 “없음”으로 확인했다. 다른 프로그램의 인증 저장소에서 값을 가져오지 않는다.

- AC-2: invalid_grant·권한 상실 중단을 격리 공급자 시험으로 검증하고 실제 revoke는 별도 차단으로 기록한다.
- AC-3: 누락·비정상 값과 식별자 불일치의 실패 테스트부터 작성, 기존 서비스 수정 후 통과 및 격리 DB 보존 확인.
- AC-4: 응답 fixture, KST 경계·다중 리스팅·120일 분할·OS 원본 보존 확인.
- AC-5: 실제 loopback HTTP MCP, bounded retry·동시 상한·DB 잠금 검증.
- AC-6: 격리 DB 저장 후 상태 readback. 실제 공급자·운영 readback은 미실행.
- AC-7: 고정 도구 allowlist·주소·파일 ID·권한·안전 오류 코드·rotation 중단 확인.

UI 변경은 없어 UI 독립 3회 검수는 해당하지 않는다. 빌드·배포 전체 기능 E2E와 중앙 검증은 이번 수집기의 격리 서비스 검증과 구분한다. 검수 기록에 차단·미실행을 그대로 남긴다.

## 실행 환경·완료 근거

이번 작업 전용 loopback HTTP MCP 및 MySQL 9.2, `127.0.0.1:33319/backoffice_console_qa`. 운영 데이터·토스 토큰을 넣지 않는다. 임시 DB는 검증 후 제거한다. 로그·실행 결과는 [검수 기록](../../qa/2026-10-12-console-sync-pod/report.md)으로 연결한다.

운영 적용, Secret 생성·배포, 스케줄 활성화, 자연 실행 readback은 별도 승인 후 수행한다. refresh token 회전이면 승인된 비회전 설계 범위를 넘으므로 중단하고 인증 보존 설계를 다시 검토한다.

2회차 인증·재시도 결함 보완은 [재검토 문서](review-followup.md)에 고정한다. 사용자의 보완 설계
승인을 기록했으며 추가 모델 리뷰는 요청하지 않는다. PR은 운영 전 gate를 유지한 Ready 검토 상태로 남긴다.

## 최초 인가 준비 (2026-10-13 KST)

- 자격증명 preflight: 214개 항목, 오류 0개. 콘솔 OAuth의 기존 활성 등록은 없다.
- 변경 전 로컬·BeeStation 암호화 백업과 각각의 임시 복원 검사 통과: 6,321개 파일, SHA-256 `b65c015316a84c742b388968b936b1fddfa4d52b96fc1a380a4337df7a918547`.
- 기존 계정 프로필과 프로그램의 OAuth 캐시는 보존한다. 새 토스 전용 프로필 `apps-in-toss`를 등록하고 일반 Chrome의 사람 로그인·동의 화면을 열었다.
- 공식 SDK의 PKCE S256, 무작위 state와 loopback callback을 사용한다. 익명 인가 요청은 공식 `business.toss.im/account/sign-in`으로 HTTP 302 응답했고 redirect 오류는 없었다.
- 예정 논리 ID는 `shared/apps-in-toss/console-oauth`다. 새 grant를 비공개 pending 파일에 수신한 뒤 실제 워크스페이스·조회 권한을 확인하고 catalog에 등록한다. 인가 전에는 활성 자격증명으로 등록하지 않는다.
- 실제 인가·갱신·재시작은 사람의 최초 로그인·동의 완료를 기다린다. 강제 갱신과 실제 만료 후 갱신, 새 프로세스·컨테이너·파드 검증은 각각 구분해 기록한다.
- 운영 자격증명 복제·Secret·CronJob 적용은 수행하지 않았다.
