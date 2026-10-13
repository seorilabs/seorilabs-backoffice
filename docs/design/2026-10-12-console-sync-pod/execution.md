# 파드 콘솔 수집 실행 티켓

**현재 승인 (2026-10-13 KST):** 운영 리소스 적용·Secret Manager/WIF 실측·전체 제품 E2E를 승인받았다. 모두 통과하면 #462 머지·운영 배포·스케줄 활성화·첫 수집 readback까지 진행한다. 아래 별도 승인 대기 기록은 당시 상태이며 현재 실행은 [운영 적용 문서](operations.md)를 따른다.

- 설계 ID: `2026-10-12-console-sync-pod`, [설계 v1](design.md)
- 승인 커밋: `0b929ccb1d9a6272fb0d4004056791d31e5eb35c`
- 사람 승인: 사용자, 2026-10-12 KST(정확한 시각 미확인). OAuth 검증·구현·검증·PR 승인, 운영 배포·스케줄 활성화 제외.
- 보완 승인: 사용자, 2026-10-13 KST. 대상 커밋 `46afeca806866e6ddc152d98afbeaaf555dda84e`, [인증·재시도 보완 설계](review-followup.md)와 새 최초 인가·로컬 자격증명 등록·실제 갱신·재시작 검증 승인. 운영 Secret·배포·스케줄 활성화는 제외.
- 실행 Issue: [#461](https://github.com/seorilabs/seorilabs-backoffice/issues/461). 코드 동작과 공개 인수조건만 기록한다. 상세 승인·검수는 이 파일과 설계 정본을 따른다.
- Ready PR: [#462](https://github.com/seorilabs/seorilabs-backoffice/pull/462). 운영 gate가 남아 있어 병합·배포하지 않는다.

## 문제·범위

대화형 수집을 전용 파드에서 실행할 수 있는 조회 경로를 만들고, 광고·결제 누락이 기존 값을 0으로 덮어쓰는 동작을 고친다. MiniMax는 기존 분석 경로를 사용한다. 보완 승인으로 새 콘솔 OAuth 최초 인가와 로컬 등록을 포함한다. v2 승인은 공개 runtime schema·migration을 포함한다. 운영 리소스/IAM 적용·배포는 범위 밖이다.

## 인수조건·검증

[설계 AC-1~7](design.md#인수조건테스트검수)을 그대로 적용한다. AC-1의 실제 최초 인가와 조회는 2026-10-13 KST에 통과했다. 새 자격증명을 로컬 카탈로그에 등록했으며 첫 실제 refresh의 회전 확인으로 만료 갱신·격리 파드 재시작은 보류한다. 다른 프로그램의 인증 저장소에서 값을 가져오지 않는다.

- AC-2: invalid_grant·권한 상실 중단을 격리 공급자 시험으로 검증하고 실제 revoke는 별도 차단으로 기록한다.
- AC-3: 누락·비정상 값과 식별자 불일치의 실패 테스트부터 작성, 기존 서비스 수정 후 통과 및 격리 DB 보존 확인.
- AC-4: 응답 fixture, KST 경계·다중 리스팅·120일 분할·OS 원본 보존 확인.
- AC-5: 실제 loopback HTTP MCP, bounded retry·동시 상한·DB 잠금 검증.
- AC-6: 격리 DB의 14개 리스팅 저장·상태 readback 통과. 실제 공급자의 첫 리스팅 조회는 통과했으며 전체 리스팅·운영 DB readback은 미실행.
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

## 최초 인가·실제 조회 (2026-10-13 KST)

- 최초 시도는 callback 뒤 교환 결과 불명으로 중단했다. 기존 상위 디렉터리 권한을 교환 뒤 검사하던 bootstrap 순서를 수정하고 비공개 하위 디렉터리를 교환 전 준비했다. 이전 인가 코드를 재전송하지 않았다.
- 새 인가 요청에서 사람이 로그인한 토스 전용 프로필로 08:07:24 KST에 새 grant를 수신했다. 공식 client/resource, state, PKCE S256를 사용하고 grant를 비공개 pending 파일에 먼저 보존했다. 성공·불완전 응답·안전한 실패의 bootstrap 합성 검사 3개도 통과했다.
- 실제 tools/list에서 날짜·집계·OS 인자가 `request` 내부에 있어야 함을 확인했다. 평탄한 입력을 통과시키던 fixture를 엄격하게 바꿔 실패부터 재현하고 수집기 입력을 수정했다.
- 수정 뒤 워크스페이스 38345와 Happy Farm `31877`의 2026-10-12 지표 도구 5회 조회는 오류 0개다. IOS 광고 결측으로 완료 행은 0개이며 0으로 저장하지 않았다. 운영 DB 쓰기는 없다.
- 새 grant의 로컬·BeeStation 백업 전체 6,322개 파일 복원·체크섬 통과. 기존 복원 파이프가 종료 141을 반환해 같은 검증을 보호된 임시 디렉터리에서 순차 추출로 수행했다. 원본 백업/복원 스크립트는 변경하지 않았다.
- 논리 ID `shared/apps-in-toss/console-oauth`를 신규 등록했다. 정본은 `~/.config/seorilabs/apps-in-toss/console-oauth/credential.json`, 0600, 하위 디렉터리 0700이다. preflight 215개 항목·오류 0개다. 등록 후 새 백업·복원 검사를 진행한다.
- 최초 access token의 실제 만료 시각은 09:07:24 KST다. 만료 시각을 바꾸거나 유효기간을 우회하지 않는다. refresh 회전이면 승인된 중단 규칙을 적용한다.
- 수정 후 전체 회귀 1,758개와 격리 MySQL의 14개 리스팅 검증이 통과했다. 제품 전체 E2E·운영 승인 상태는 그대로 남긴다.

## 실제 refresh 회전 중단

등록 후 로컬·BeeStation 백업은 전체 6,323개 파일 복원·체크섬 통과다(SHA-256
`21cdb873ac4e92de447059485e785037b3b0ddc5f7b2e6e31094d11e7f390e81`).
첫 실제 강제 refresh의 정상 응답에서 기존과 다른 refresh token을 확인했고
`OAUTH_ROTATION_REQUIRES_REVIEW`로 종료 1이다. 새 값을 임의 보존·사용하지 않았고
원본 파일 fingerprint는 변하지 않았다. 동일 grant를 다시 전송하지 않았다.

카탈로그 상태는 `unresolved`로 기록했다. 자연 만료 후 갱신·실제 파드 재시작은 회전 중단으로
미실행이며 AC-1은 아직 미통과다. 준비했던 로컬 kind 1.37 클러스터는 정리했다. 인증 검사용
파드·OAuth 실행 복제본은 만들지 않았다. 격리 MySQL도 소유 ID 확인 후 제거했고 loopback
callback 서버는 종료했다. 운영 Secret/DB/배포/스케줄은 변경하지 않았다.

후속 승인 대상은 [회전 보존 설계 v2](../../design/2026-10-12-console-sync-pod/rotation-v2.md)다.
서버에서 갱신된 grant를 보존하는 경로와 이 OAuth만의 정본·자동 갱신 백업 정책 예외가
필요하다. 현재 코드는 회전을 성공으로 처리하는 변경 없이 안전 중단을 유지한다.

최종 `unresolved` 카탈로그를 포함한 암호화 백업도 로컬·BeeStation 양쪽 전체 6,349개 파일
복원·체크섬 통과다(SHA-256 `2bed3a9749491009a124ae006696fee24d069ddaf4d25dfe0d79112d36c60b57`).
실제 조회·중단·검증 환경·남은 gate의 비밀값 없는 요약은
[provider 검증 근거](../../qa/2026-10-12-console-sync-pod/provider-verification.json)에 기록했다.

## v2 실행 승인 (2026-10-13 KST)

[회전 보존 설계 v2](rotation-v2.md)의 `17c5f6cf1513d6e9d0d0e725af0deb34effeff3c`를 사용자가 승인했다. 새 runtime 상태 schema/migration, Secret Manager 어댑터, 새 최초 인가, 불변 버전 보존·실제 만료 갱신·격리 파드 재시작 및 PR 갱신을 포함한다. 이 OAuth의 운영 정본과 정상 자동 갱신 보존 정책 예외를 승인했다. 운영 리소스/IAM 적용·배포·스케줄 활성화는 승인 대기이며 기존 회전 중단 기록은 과거 v1 결과로 보존한다.

기존 임시 checkout 소실 뒤 보존된 merge 커밋 `9530fb225ae69fb08024fdc0131db36bf2ee9a3d`에서 managed worktree를 복구했다. 사용자 main의 `.serena/`와 다른 작업은 변경하지 않았다. 초기 자격증명 변경 전 로컬/BeeStation 전체 복원 검사: SHA `1d3ffadf5016b6975c2fe733f69720ee6c7d3bd5c191df5f92192170a897b822`, 6,349개 파일, 양쪽 통과.

## v2 구현·만료 전 확인

- 첫 TDD 실패: 회전 보존 인수조건이 기존 `OAUTH_ROTATION_REQUIRES_REVIEW` 때문에 실패했다. v2 구현 뒤 보존·readback·CAS 순서와 장애 시 영속 중단을 확인했다.
- 추가 TDD 실패: 유효 access token으로 조회하는 동안 강제 refresh가 진행되면 IN_FLIGHT 중 MCP를 보낼 수 있었다. 진행 중 갱신을 기다리고 ACTIVE만 전송하도록 수정했다.
- 격리 MySQL의 14개 리스팅 저장·결측 보존·readback, 별도 runtime 스키마의 RBAC·고정 workspace·CAS 경합·멱등·append-only 감사·새 DB 연결 IN_FLIGHT 차단 통과.
- 새 최초 인가: 2026-10-13 17:50:12 KST. 실제 만료: 18:50:11 KST. 최초 조회와 비루트·읽기 전용 kind 파드에서 generation 1·refresh 전송 0회 확인. IOS 광고 결측은 그대로 제외한다.
- 격리 파드의 최초 Node slim/OpenSSL 부족 실패는 인증 전 발생했으며 runtime ACTIVE를 확인했다. OpenSSL을 포함한 비밀 없는 QA 이미지로 실제 조회 통과.
- Secret Manager REST/CRC32C/WIF 설정 어댑터는 합성 응답 검증이다. 운영 리소스·IAM·Secret Manager live proof를 만들지 않았다.
- UI 변경 없음. 전체 제품 E2E 43개와 운영 승인은 별도 gate다. 기존 PR당 교차 리뷰 2회 상한을 넘겨 요청하지 않는다.

- 발급 뒤 잠금 손실은 immutable 버전을 먼저 보존해 orphan으로 남기고 활성화 CAS는 차단한다. 관련 장애 테스트에 보존된 버전 수를 확인했다.

- CI `38376084074`: verify(타입·lint·1,774개 테스트·정적 Next 빌드) 통과. empty/cutover는 새 runtime table 추가 후 schema-contract-current 기준이 갱신되지 않아 실패했다. 격리 MySQL 실측(테이블 +1, 컬럼 +7, 인덱스 +1, FK 동일)으로 기준을 갱신하고 cutover의 새 빈 table 목록에 해당 table만 추가한다. 검증을 비활성화하지 않는다.

- 정본 전환·복구에서 초기 runtime 등록이 무조건 generation 1로 시작하는 실패를 TDD로 확인했다. REGISTER는 확인된 grant의 registeredGeneration을 보존하고 현재 generation보다 작거나 같은 복구를 거부하도록 보완했다. 자동 BEGIN/COMPLETE는 이 필드를 받을 수 없다.

## v2 실제 만료·회전 보존·파드 재생성 완료

2026-10-13 18:51:11 KST 실측에서 원래 만료(18:50:11 KST) 이후 자동 refresh 1회·HTTP 200·refresh 회전을 확인했다. 암호화 불변 버전 보존·정확한 버전 readback·ACTIVE CAS 이후 generation 1→2와 실제 워크스페이스/지표 조회가 통과했다. 만료 시각을 수정하지 않았다.

18:51:18 KST 새 UID의 같은 이름 파드는 generation 2를 추가 refresh 0회로 재사용했다. 18:51:24 KST 강제 refresh 1회·HTTP 200·회전 보존으로 generation 3을 만들고, 18:51:29 KST 또 다른 UID의 파드가 추가 refresh 0회로 재조회했다. 실행 UID·원래/현재 만료·정확한 버전·소스 해시는 `provider-rotation-v2.json`에 기록했다. 해당 파일은 인증 수명 검증이며 제품 전체 E2E 기록이 아니다.

격리 DB 공개 상태는 ACTIVE·generation 3·attemptId null, 감사 5행이다. 암호화된 grant와 대조한 최신 상태를 로컬 정본에 0600·fsync·readback으로 내보내고 카탈로그를 갱신했다. 초기/이전 버전과 암호화 키는 보존하며 소비된 토큰을 fallback으로 사용하지 않는다. Happy Farm 31877의 2026-10-12 IOS 광고 결측은 모든 조회에서 그대로 남았고 완료 행 0개·운영 DB 쓰기 0회다.

CI [38377735363](https://github.com/seorilabs/seorilabs-backoffice/actions/runs/38377735363)은 1,775개 테스트·타입·lint·정적 Next 빌드·MySQL empty/cutover를 모두 통과했다. 사용자 정의 이름의 로컬 이관 DB는 schema 계약 뒤 operations fixture의 격리 이름 조건으로 실패했으며, 이를 통과로 바꾸지 않았다. 정상 이름의 전체 검증은 CI에서 확인했다.

최신 main `0a4e588`을 병합하며 목록과 검수 문서 충돌은 양쪽 기록을 보존했다. 전체 기능 수는 44개이며 OAuth 구현 해시는 실측 소스 `e0a5c1e`와 동일하다. 최종 후보 CI와 중앙 검증 결과는 별도로 기록한다. Secret Manager/WIF/IAM live 검증·전체 제품 E2E·실제 revoke·모든 리스팅 운영 저장은 미실행이다. 운영 리소스·배포·스케줄은 별도 승인 대기다.

최신 generation 3 포함 백업 `20261013T185312+0900`은 로컬·BeeStation 모두 6,386개 파일의 전체 복원·체크섬을 통과했다. archive SHA-256: `fc4414564983fe168d5b54d51c58de7ad0e7bb55a5691e2de14430b796b3f098`. 갱신마다 전체 백업을 수행하는 정책으로 바꾸지 않았으며 정상 회전의 불변 암호화 버전·readback·CAS 예외를 사용했다.

최신 상태 내보내기와 양쪽 복원 gate 후 내 kind 클러스터·MySQL/gateway 컨테이너·전용 QA 이미지·임시 gateway key를 정리했다. 암호화 버전 3개와 encryption.key, 초기/과거 grant 아카이브는 보존한다. 사용자 QA 컨테이너·공용 브라우저·main의 untracked 작업은 변경하지 않았다.
