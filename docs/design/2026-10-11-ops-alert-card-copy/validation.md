# 구현·적용 검증 — BO-ALERT-COPY-20261011-v3

## 승인과 실행

- 사용자 승인: v1 카드 방향 “시안은 좋다”; v2 “확대안도 적용하고”; v3 “v3대로 진행”.
- 실행 티켓: [#453](https://github.com/seorilabs/seorilabs-backoffice/issues/453).
- 코드·정기 실행 정의와 중앙 모니터링 설정을 구분한다. 운영 설정 확대는 적용됐으며 코드 배포·일일 정기 실행 활성화는 별도 배포 승인 대기다.
- 기존 primary checkout과 `.serena/`, 다른 세션 worktree를 보존하고 origin/main `9dbb159bbcbd31cb612309bfd4e3f2d45df7d1b6` 기준 별도 worktree에서 구현했다.

## 중앙 설정 확대 — 적용 후 readback 일치

기존 control-plane API의 새 DRAFT 생성·ACTIVE 활성화, validator·동시성 확인·idempotency·감사를 사용했다. DB 직접 설정 수정은 하지 않았다. 모든 앱에서 키워드 외 기존 payload와 monitoring 필드가 일치했다. 블룸핸드는 기존 exact-source 발견 기반 DRAFT의 markets를 보존하며 monitoring만 추가했다. 법적 선언·계정·심사·공개 상태는 입력하거나 변경하지 않았다.

| 앱 | 적용 ACTIVE 버전 | 국가 | 조합 수 |
| --- | --- | --- | --- |
| 가로세로 낱말 퍼즐 | 55 유지 | KR | 2 |
| 달빛 맞고 | 40 | US | 3 |
| 도마뱀 테라리움 | 149 | KR·US | 12 |
| 루시드 체스 | 53 유지 | KR·US | 6 |
| 마켓팝 | 77 | KR·US | 10 |
| 머지 함대 | 28 | KR·US | 12 |
| 삼국지 풍운록 | 82 | KR·US | 10 |
| 영혼의 문 디펜스 | 33 | KR·US | 10 |
| 조물조물 만물 합치기 | 50 | KR·US | 10 |
| 함께봄 | 56 | KR·US | 12 |
| 행복 농장 타이쿤 | 42 | KR·US | 12 |
| 블룸핸드 | 2 | KR·US | 12 |
| 합계 | 12개 앱 | | 111 |

추가 45조합은 다음 자연 수집에서 최초 관측을 만든다. 설정 활성화를 새 순위 수집 성공으로 보고하지 않는다. 최초 관측에는 비교 변화 알림을 만들지 않는다. PAUSED 앱을 수집 대상에서 제외해 화면의 일시중지 표시와 실제 실행을 일치시켰다.

## 자동·서비스 검증

- 새 순수 모듈 테스트를 구현 전에 작성했으나 최초 실행은 모듈 미존재의 import 오류에서 중단됐다. 이 로그를 행동 assertion의 RED로 세지 않는다. 해당 조건은 test-first 증거 미확보로 기록하고, 아래 단위·서비스 검사와 실제 UI 실패→수정→재확인을 대체 검증으로 사용한다. 운영 설정 readback·실제 브라우저 배치도 공급자 전송 없이 해당 환경에서 검사한다.
- 대체 검사 범위: 59/60분 경계, 상태·날짜 변경의 구간 유지, 정상 observed/empty만 회복, 실행 중·미확인 제외, critical OPEN 최초 멘션, 전체 설정 조합·결측·이전 날짜·CSV 수식 방지. 운영 적용 후 readback인 AC8은 배포 전 통과로 표시하지 않는다.
- 전체 단위 테스트 1,734개 통과. 변경 영역 추가 최종 검사 통과.
- 별도 localhost QA DB의 기존 operations acceptance 통과: 신호 중복, lease 소유권, fallback, 편집 중 갱신 경합, concurrency·일일 ceiling.
- 별도 `backoffice_cutover_contract_test`에서 새 서비스 E2E 통과: 실제 triggers → 불변 signal → insight/outbox, Play 59/60분·구간당 경고·경고한 구간만 회복·일시 실패 요약; 실제 Discord 요청 생성의 기존 대기 OPS_ALERT 무멘션·중대 장애 첫 호출·반복 편집·404 대체 무멘션·일일 CSV 첨부/동일 카드 갱신·최초 발행 재대기 방지.
- Discord HTTP는 격리 모의 응답만 사용했다. 실제 채널에 시험 메시지를 보내지 않았다.
- typecheck/lint와 build:scripts는 통과했고 lint의 기존 `_ignored` 경고는 본 변경과 무관하다. Next build는 최종 후보 개발 E2E 뒤 실행한다.

실행 산출물: `/Users/syous/Workspace/artifacts/backoffice/ops-alert-card-copy-20261011/`의 `expansion-readback.json`, `tests-final.log`, `operations-acceptance.log`, `collection-policy-e2e.log`, `focused-final.log`, `typecheck-final.log`, `build-scripts.log`. 비공개 설정 원본·QA 인증값은 저장소에 포함하지 않는다.

## 독립 UI 검수와 전체 기능 E2E

- 새 MySQL9.2 격리 컨테이너·localhost:3111 실제 Next 개발 서버·공용 Playwright의 소유 테스트 세션. 운영 DB·외부 키 미사용.
- UI1 실패 보존: 이전 표의 null 순위를 “200위 밖”으로 단정. “결과 목록에 없음”으로 수정했다.
- UI2 통과: 12개 앱·111행·상태·전일 비교, 앱별 설정 링크, 기준일·잘못된 날짜, 핵심 10개 화면과 인사이트→실제 초안 입력, 390px 화면·글자 200%·표 내부 키보드 스크롤을 확인했다. macOS 입력 자동화의 첫 시도 실패는 자동화 오류로 보존하고 제한된 한 번의 재시도로 기능 통과를 확인했다.
- UI3 통과: 핵심 화면·11개 호환 경로, 초안 새로고침·소유 개발 서버 재시작 뒤 저장 보존, 111행·66수집·45미수집, 기존 안정성 화면을 확인했다. 모바일 앵커가 고정 헤더에 가려지는 P2 결함을 보존하고 `scroll-mt-32 md:scroll-mt-4`를 추가했다. 같은 열린 회차 안에서 해당 문제를 한 번 재확인해 기본 글자 제목 y145~169/헤더0~61, 글자200% 제목 y289~385/헤더0~121로 완전 노출됨을 확인했다. 최초 재확인 도구의 동일 문서 navigation 오류는 제품 체크 0개의 도구 오류로 따로 보존했다. UI4는 실행하지 않았다.
- 3회 실제 실행 기록: 위 산출물 경로의 `ui-qa/round1/`, `round2/`, `round3/`의 계획·후보·브라우저 결과·보고서. 시안 캡처를 제품 실행 검수로 세지 않는다.
- 최종 커밋 뒤 실행하는 before-build E2E·빌드 결과는 소스 SHA를 다시 바꾸지 않도록 같은 산출물 경로의 최종 후보별 JSON·로그 및 PR에 기록한다. 중앙 검증기로 후보·42개 기능 목록·독립 검수·시간 순서를 대조하고 검수 보관용 `development-evidence` Draft Release에 보존한다.
- 외부 GitHub 발행·마켓·결제·AI·Vault·Discord 실제 provider 성공은 격리 환경 검증으로 주장하지 않는다. 기존 42개 기능의 화면·서비스 계약·차단 상태를 현재 후보와 연결한다.

## 승인된 배포의 적용 대상과 복구

새 코드의 운영 적용 전 최종 main SHA·CI·immutable digest를 고정하고 before-deploy 개발 E2E를 실행한다. 일반 배포 스크립트는 운영 인사이트 Deployment와 market/weekly CronJob을 갱신하지 않으므로 trusted operator 단계에서 같은 digest로 **이미지만** 바꾸고 기존 replica·suspend·schedule·env를 보존한다. 기존 비활성 manifest 기본값을 활성 자원에 덮어쓰지 않는다.

새 `backoffice-keyword-daily` CronJob은 `keyword-daily` 실행 모드·UTC `40 3 * * *`로 매일 12:40 KST 발행한다. 저장소 정의는 suspend=true이며 승인된 배포 때 같은 digest로 생성하고 활성화한다. 수집 Job과 별개라 수집이 실패해도 미수집·실패를 보고한다. collector에 전송 토큰·역할 권한을 주입하지 않는다. 일반 notification worker만 전달한다.

적용 후 웹/알림 실행기와 인사이트 생산자·정기 실행의 digest, readiness, 12개·111조합 설정을 다시 읽고 다음 자연 수집·12:40 발행의 event/delivery·첨부·멘션을 확인한다. 현재 새 코드의 실제 Discord 발송·운영 적용은 미실시다.

복구는 이전 immutable 이미지로 되돌리고 새 daily CronJob을 중지한다. 설정 복구가 필요하면 기존 control-plane 서비스로 이전 payload의 새 revision을 활성화하며 원장·감사·Discord 이력을 삭제하지 않는다.
