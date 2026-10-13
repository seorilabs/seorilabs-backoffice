# 파드 콘솔 수집 검수

설계 ID: `2026-10-12-console-sync-pod`. [승인·실행 티켓](../../design/2026-10-12-console-sync-pod/execution.md).

## v1 환경·실행 계획

새 콘솔 OAuth 최초 인가·실제 조회와 로컬 카탈로그 등록을 통과했다. 첫 실제 refresh가 회전 중단되어 만료 갱신·재시작은 보류다. 로컬 HTTP MCP 시험 서버는 공식 SDK와 합성 응답만 사용한다. MySQL 9.2 격리 DB는 `127.0.0.1:33319/backoffice_console_qa`이며 운영 키·데이터를 사용하지 않는다.

테스트 순서: 실패 조건 확인 → 매핑·ingest 수정 → OAuth·HTTP MCP 경계 → 격리 DB 수집·보존·잠금·readback → 타입·린트·전체 회귀 → 중앙 개발 근거 검증 → PR CI·교차 리뷰.

## v1 진행 결과

- ingest 원본에서 불완전한 행·다른 리스팅 ID가 저장되어 회귀 assertion 2개 실패(예상 결과).
- mapper 미구현 상태에서 정상 행·누락 사유 assertion 2개 실패(예상 결과).
- 수정 후 매핑·저장 보호 및 기존 검사 9개 통과.
- OAuth 격리 검사 5개, 날짜·분할 2개 통과.
- 실제 loopback HTTP MCP 검사 2개 통과: refresh·429·동시 조회 최대 2·쓰기 도구 차단·IOS 누락·재시도 소진.
- 격리 MySQL에서 전체 14개 리스팅 저장·완료 판정·readback 통과. 출시일 미확인 차단, 결측 시 기존 행/관측 보존, 동시 DB 잠금, 실패 뒤 잠금 해제와 새 OAuth 인스턴스 조회도 통과.
- 타입 검사·린트 통과. 기존 `release-tag-ledger.test.ts`의 미사용 변수 경고 1개는 범위 밖으로 남긴다.
- 전체 회귀 1,748개 통과(실패·skip 0).
- worker 개발용 묶음 생성 통과, 자격증명 없는 `verify-refresh`는 안전 코드 `OAUTH_CREDENTIAL_REQUIRED`로 종료 1.
- 중앙 검증기 실제 실행은 실패(예상된 차단): AC-1/2/6의 blocked 상태와 전체 E2E 미실행을 통과로 허용하지 않는다.
- `pnpm build`: 전체 기능 E2E 차단으로 미실행. worker 묶음은 개발용 실행 검증이며 제품 빌드 gate 통과가 아니다.
- PR CI·교차 리뷰: PR에서 최신 결과를 확인한다. 이번 단계는 운영 배포·병합을 수행하지 않는다.

## v1 당시 남은 gate

- AC-1 최초 인가·워크스페이스와 첫 리스팅 조회: 통과. 토큰 만료 후 refresh·격리 파드 재시작: 회전 보존 설계 승인 대기.
- AC-2 실제 revoke 및 AC-6 전체 실제 리스팅/운영 DB readback: 미실행. 첫 리스팅 조회는 통과했지만 IOS 광고 결측으로 완료 행은 없다.
- 이번 후보의 Backoffice 전체 기능 43개 E2E 증거: 미실행. 과거 후보를 재사용하거나 서비스 fixture를 전체 제품 검수로 표시하지 않는다.
- 운영 배포·Secret 적용·CronJob 활성화: 미승인, 미실행. manifest는 suspend=true이고 기존 배포 적용 목록 밖이다.

## 재현 명령·근거

```bash
pnpm typecheck
pnpm lint
pnpm test
# 운영 DB에 실행하지 않는다. localhost:33319/backoffice_console_qa만 허용한다.
DATABASE_URL='<격리 DB URL>' node --import tsx scripts/test-console-metrics.ts
```

TDD 기준은 origin/main `f7682393443e3a6d0436af7ad3d4dafb4b30341e`의 ingest다.
누락 IAP와 slug/miniAppId 불일치에서 `1 !== 0` assertion이 실패했고, 수정 후 동일 검사가 통과했다.
OAuth·HTTP 검사는 실제 공급자 실패를 재현한 합성 응답 시험이며 실측 OAuth 성공을 증명하지 않는다.

로컬 `console-sync` 스킬은 승인된 조회 전용 경로에 한해 개정했다. 최초 동의·등록 identity·실제
갱신·회전·재시작 검증·별도 운영 승인·만료 우회 금지 조건을 유지한다.

## 교차 리뷰 반영

[PR #462](https://github.com/seorilabs/seorilabs-backoffice/pull/462)에 읽기 전용 Claude 원문을 게시했다.
Copilot 자동 리뷰의 일반 token 키와 중복 날짜 지적을 수용해 먼저 실패하는 assertion을 추가했다.
Claude의 불완전한 회전 응답·OAuth 설정 오류·HTTP 전체 시간 예산·429 중단·저장소 명령 계약·
비어 있지 않은 DAU 경로·죽은 분기·필수 필드 타입·무관한 auth lockfile 변경을 보완한다.

행 전체 보류와 공통 minLastDate overlap은 승인 설계·기존 런북의 의도된 정책이다. 빈 배열을 0으로
확정하거나 nullable 스키마/부분 필드 갱신을 도입하지 않는다. DB 전용 리스팅은 현재 상태 응답에
workspace가 없으므로 자동 수집에서 확인 필요로 차단하고 기존 상태·push API는 보존한다.

기존 PR CI는 Next 빌드까지 통과했다. 전체 제품 E2E 중앙 gate는 여전히 차단이다.
리뷰 반영 후보의 최신 테스트·CI와 2회차 수정분 리뷰는 PR 코멘트에서 확인한다.

리뷰 반영 후 typecheck·lint 및 전체 1,754개 테스트(실패·skip 0), 격리 DB 14개 리스팅의
저장·readback·기존 행 보존·요청 제한 시 후속 조회 중단이 통과했다. HTTP 전체 예산 검사는
대기 중인 재시도가 취소된 뒤 추가 요청이 없음을 확인한다.

## 2회차 교차 리뷰 보완

남은 예산보다 긴 429는 전체 실행 중단, 갱신 전송 취소·결과 불명은 연결 중단, 비JSON 오류는
HTTP 상태별 처리를 유지하도록 보완했다. 일반 비밀 키 변형과 오류 코드 대응을 추가했다.
먼저 실패한 assertion과 수정 후 통과를 확인했으며, 추가 모델 리뷰는 2회 상한으로 요청하지 않는다.
같은 영역의 반복 지적에 대한 [보완 설계](../../design/2026-10-12-console-sync-pod/review-followup.md)는 사용자에게 2026-10-13 KST 승인받았다. 추가 모델 리뷰는 요청하지 않는다.

최종 보완 후 typecheck·lint, 전체 1,757개 회귀(실패·skip 0), 14개 리스팅 격리 DB 검증이
통과했다. loopback HTTP에서 실제 20초를 기다린 연속 Retry-After 2회는 25초 예산 부족을
RATE_LIMITED로 분류해 후속 조회 없이 중단했다. 공유 갱신 취소와 비JSON 오류 assertion도 통과했다.

## 실제 OAuth 최초 인가 준비

2026-10-13 KST에 보완 설계와 새 최초 인가·등록·실제 갱신·재시작 검증 범위를 승인받았다.
자격증명 카탈로그 preflight 오류 0개, 변경 전 로컬·BeeStation의 암호화 백업·임시 복원 모두
통과했다(6,321개 파일). 새 토스 전용 프로필과 공식 SDK PKCE callback을 준비했다.
익명 인가 요청의 HTTP 302 로그인 경로는 확인했으며, 사람의 로그인·OAuth 동의를 기다린다.
현재 인가 완료·자격증명 활성 등록·실제 공급자 refresh·만료·재시작은 아직 통과가 아니다.

실제 확인 순서는 최초 grant로 워크스페이스 38345와 리스팅 조회 → catalog 등록·백업·복원 →
강제 갱신 → 실제 만료 후 갱신 → 새 실행의 조회·갱신이다. 회전 또는 결과 불명은 현재 설계대로
중단하며 옛 grant를 반복 사용하지 않는다. 조회 확인은 지표 수·결측·오류도 별도 기록한다.
이번 준비 단계에서 수집기 제품 코드·의존성은 변경하지 않았다.

최신 중앙 계약의 기반 기능 30일 재사용 조건도 확인했다. 실제 통과 기준 SHA·동일 기능 정의와
담당 경로의 변경 없음이 확인된 경우만 이어받는다. 이번 OAuth 수집 기능은 신규·변경 경로이므로
과거 근거나 fixture로 실제 provider 검증을 대체하지 않는다. 전체 제품 E2E도 기존 차단을 유지한다.

## 실제 인가와 입력 계약 수정 (2026-10-13 KST)

최초 loopback 시도는 callback 뒤 교환 결과 불명으로 종료했다. OAuth 응답 뒤 실행하던
디렉터리 권한 검사를 교환 전으로 옮기고 비공개 하위 디렉터리를 준비한 뒤 새 요청을 진행했다.
기존 인가 코드를 재전송하지 않았다. 새 요청은 토스 전용 프로필의 사람 로그인을 통해
08:07:24 KST에 성공했고 최초 토큰의 실제 만료는 09:07:24 KST다.

실제 tools/list 계약에서 날짜·집계·OS 인자는 `request` 내부임을 확인했다. 최초 실측의
평탄한 입력은 지표 5회 모두 MCP_TOOL_FAILED였으며 인증·워크스페이스 오류와 구분했다.
fixture를 엄격하게 변경해 기존 수집 흐름이 `0 !== 2`로 실패하는 것을 먼저 재현했다.
수정 후 HTTP 검사 5개, 전체 회귀 1,758개(실패·skip 0), 타입·린트와 격리 MySQL의 14개
리스팅 readback·결측 보존·잠금이 통과했다. 기존 린트 경고 1개는 그대로다.

수정한 소스의 최초 provider 조회와 실제 worker `verify-auth` 모두 워크스페이스 38345,
Happy Farm `31877`의 2026-10-12 지표 5회를 오류 없이 응답받았다. IOS 광고 결측으로
완료 행은 0개이며 기존 지표/운영 DB를 쓰지 않았다. 최초 조회에는 refresh가 발생하지 않았다.

새 grant는 0600 파일·0700 하위 디렉터리로 보존했다. 6,322개 파일이 포함된 로컬·BeeStation
백업은 양쪽 전체 복원·체크섬 검사 통과다. 기존 복원 파이프가 종료 141을 반환해 보호된 임시
디렉터리에서 순차 복호화·추출한 뒤 동일한 전체 파일 체크섬을 검사했다. 원본 스크립트는
변경하지 않았다. 신규 논리 ID `shared/apps-in-toss/console-oauth`를 등록했고 preflight 오류 0개다.
등록 후 백업·양쪽 복원, 실제 강제 갱신·만료 갱신·격리 파드 재시작은 결과를 이어서 기록한다.

인가 bootstrap 합성 검사 3개는 성공·불완전한 응답에서도 새 grant 보존·안전한 실패·코드 재사용
차단을 확인했다. 이 합성 결과를 실제 refresh나 제품 전체 E2E로 표시하지 않는다.

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

## v2 현재 검증 (2026-10-13 KST)

사용자 승인으로 v2 구현과 새 인가를 진행했다. 만료 전 실제 비루트·읽기 전용 kind 파드 조회 통과(generation 1, refresh 0회). 원본 만료 18:50:11 KST 이후 자동 갱신·회전 보존·파드 재생성 검증은 대기 중이다. v1 회전 중단 기록을 과거 근거로 보존하며 새 승인으로 소급 PASS 처리하지 않는다.

전체 회귀 1,773개 통과 뒤 추가 동시 갱신 TDD에서 유효 access token 조회가 IN_FLIGHT 중 전송될 수 있는 결함을 재현·수정했다. 수정 후 관련 OAuth·버전·runtime 검사 12개 통과. 최신 전체 회귀·타입·린트·CI는 최종 후보에서 확인한다. 별도 격리 MySQL runtime schema에서 권한·CAS·멱등·append-only 감사·새 DB 연결의 IN_FLIGHT 차단도 통과했다. 운영 데이터·Secret Manager/IAM은 적용하지 않았다.

## v2 실제 만료·회전 보존·파드 재생성 완료

2026-10-13 18:51:11 KST 실측에서 원래 만료(18:50:11 KST) 이후 자동 refresh 1회·HTTP 200·refresh 회전을 확인했다. 암호화 불변 버전 보존·정확한 버전 readback·ACTIVE CAS 이후 generation 1→2와 실제 워크스페이스/지표 조회가 통과했다. 만료 시각을 수정하지 않았다.

18:51:18 KST 새 UID의 같은 이름 파드는 generation 2를 추가 refresh 0회로 재사용했다. 18:51:24 KST 강제 refresh 1회·HTTP 200·회전 보존으로 generation 3을 만들고, 18:51:29 KST 또 다른 UID의 파드가 추가 refresh 0회로 재조회했다. 실행 UID·원래/현재 만료·정확한 버전·소스 해시는 `provider-rotation-v2.json`에 기록했다. 해당 파일은 인증 수명 검증이며 제품 전체 E2E 기록이 아니다.

격리 DB 공개 상태는 ACTIVE·generation 3·attemptId null, 감사 5행이다. 암호화된 grant와 대조한 최신 상태를 로컬 정본에 0600·fsync·readback으로 내보내고 카탈로그를 갱신했다. 초기/이전 버전과 암호화 키는 보존하며 소비된 토큰을 fallback으로 사용하지 않는다. Happy Farm 31877의 2026-10-12 IOS 광고 결측은 모든 조회에서 그대로 남았고 완료 행 0개·운영 DB 쓰기 0회다.

CI [38377735363](https://github.com/seorilabs/seorilabs-backoffice/actions/runs/38377735363)은 1,775개 테스트·타입·lint·정적 Next 빌드·MySQL empty/cutover를 모두 통과했다. 사용자 정의 이름의 로컬 이관 DB는 schema 계약 뒤 operations fixture의 격리 이름 조건으로 실패했으며, 이를 통과로 바꾸지 않았다. 정상 이름의 전체 검증은 CI에서 확인했다.

최신 main `0a4e588`을 병합하며 목록과 검수 문서 충돌은 양쪽 기록을 보존했다. 전체 기능 수는 44개이며 OAuth 구현 해시는 실측 소스 `e0a5c1e`와 동일하다. 최종 후보 CI와 중앙 검증 결과는 별도로 기록한다. Secret Manager/WIF/IAM live 검증·전체 제품 E2E·실제 revoke·모든 리스팅 운영 저장은 미실행이다. 운영 리소스·배포·스케줄은 별도 승인 대기다.

최신 generation 3 포함 백업 `20261013T185312+0900`은 로컬·BeeStation 모두 6,386개 파일의 전체 복원·체크섬을 통과했다. archive SHA-256: `fc4414564983fe168d5b54d51c58de7ad0e7bb55a5691e2de14430b796b3f098`. 갱신마다 전체 백업을 수행하는 정책으로 바꾸지 않았으며 정상 회전의 불변 암호화 버전·readback·CAS 예외를 사용했다.

최신 상태 내보내기와 양쪽 복원 gate 후 내 kind 클러스터·MySQL/gateway 컨테이너·전용 QA 이미지·임시 gateway key를 정리했다. 암호화 버전 3개와 encryption.key, 초기/과거 grant 아카이브는 보존한다. 사용자 QA 컨테이너·공용 브라우저·main의 untracked 작업은 변경하지 않았다.
