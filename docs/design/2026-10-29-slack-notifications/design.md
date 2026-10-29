# Slack 운영 알림 시험 도입

- 설계 버전: 1
- 상태: 구현 전 사람 검토 대기
- 기준 소스: `ea965a5a2a6512e4e07ac158a65133e16b9c0316`
- 요청 근거: Discord 모바일의 반복적인 채널 목록 표시 문제 때문에 Slack 무료판을 시험한다. 사용자가 `seorilabs.slack.com`과 운영 계정 `ih@seorilabs.com`을 지정하고 초기 설정을 위임했다.
- 현재 승인: 지정 워크스페이스 로그인, 채널과 연동 앱 준비. 아래 소프트웨어 변경과 운영 배포는 이 설계와 테스트 계획을 검토받은 뒤 진행한다.

## 목적과 범위

Slack에서 운영 보고와 사용자 리뷰를 받아보며 모바일 사용성을 평가한다. 관측 원장과 실행 기록은 Backoffice, 코드와 작업 기록은 GitHub에 유지한다. 기존 Discord 전송과 운영 명령은 시험 기간 동안 유지한다.

| Slack 채널 | 기존 논리 목적지 | 받는 내용 |
| --- | --- | --- |
| 운영보고 | `metrics-daily`, `app-ops` | 기존 발송 정책을 통과한 지표와 운영 보고 |
| 사용자리뷰 | `user-reviews` | 기존 기준을 통과한 사용자 리뷰 보고 |
| 장애알림 | `ops-alerts` | 실제 영향이 확인된 장애 안내. 승인 요청과 실행 버튼은 제외 |
| 수집결과 | `batch-monitoring` | 기존 예약 작업 결과 보고 |

첫 단계에는 명령, 배포 승인, 마켓 제출, 메시지에서 작업을 실행하는 버튼, 과거 메시지 이관을 포함하지 않는다. 이미지와 CSV 등 기존 보고 첨부는 Slack 파일 업로드로 전달한다. 새 분석이나 자동 알림 종류를 만들지 않는다.

## 사용 흐름과 표시

관측 저장 → 기존 보고 여부 판단 → 서비스별 전송 대기 기록 → Slack 게시 → 같은 보고가 바뀌면 같은 메시지 갱신.

```text
[앱 이름과 결론]
비교 기간과 수치, 확인된 영향
실제로 필요한 조치가 있을 때만 조치 표시
Backoffice 원문 링크
[기존 보고에 포함된 이미지 또는 파일]
```

Slack의 기본 메시지 화면을 사용한다. Backoffice 화면은 변경하지 않는다. 승인 기능이 없는 메시지에 승인 버튼을 흉내 내거나 성공 상태를 생성하지 않는다. 원문 확인 링크만 제공한다. 앱과 보고서에 이미 적용된 개인정보와 리뷰 원문 보존 제한을 확대하지 않는다.

## 구조와 데이터

- `NotificationEvent` 하나에 `DISCORD`, `SLACK` 각각의 `NotificationDelivery`를 생성한다. 두 서비스의 전송 성공, 실패, 메시지 ID와 재시도는 분리한다. 기존 이벤트의 최초 목적지는 바꾸지 않으며, 활성화 이후 신규 이벤트만 Slack 목적지를 추가한다.
- `NotificationProvider`에 `SLACK`을 추가하는 호환 migration을 사용한다. 기존 enum 값과 순서, 데이터는 유지한다. MySQL enum 변경은 기존 migration 안전 검사에 정확한 SQL과 검토 근거를 등록한다. DB 복원이나 데이터 삭제를 복구 방법으로 사용하지 않는다.
- 기존 outbox의 claim, 중복 방지, 보고 판단, 정정과 재시도를 재사용한다. delivery callback에 provider와 event 식별자를 전달하여 서비스별 전송기를 선택한다. Discord 전용 카드와 스레드 경로는 그대로 둔다.
- Slack 전송기는 기존 보고 payload의 제목, 본문, 링크와 첨부를 Slack 형식으로 렌더링한다. Discord 전송 함수를 호출하거나 Discord 게시 성공을 Slack 게시 성공으로 처리하지 않는다.
- 첫 단계 목적지를 명시적으로 제한한다. 승인 요청, release 카드, 직접 명령 응답은 Slack 대기 기록을 만들지 않는다. 지원하지 않는 payload를 성공으로 처리하거나 본문 없이 보내지 않는다.
- 봇 토큰은 로컬 자격증명 정본에 저장하고 암호화 백업과 복원 검증 후 실행 환경에 복제한다. 카탈로그에는 공개 workspace와 app identity, scope와 경로를 기록한다. 채널 ID는 공개 설정이며 기존 환경 설정 방식으로 주입한다. 별도 앱 운영 JSON 정본을 추가하지 않는다.
- 초기 앱 권한은 `chat:write`, `channels:read`, `files:write`다. 채널은 운영자 UI에서 만들고 봇을 직접 초대한다. 사용자 대화 읽기, 비공개 메시지 접근, 운영자 계정 대신 실행하는 토큰은 요청하지 않는다.

## 실패와 보존

Slack의 HTTP 응답과 JSON `ok`를 모두 확인한다. 429는 `Retry-After`를 반영한다. 잘못된 토큰, 권한 부족, 미참여 채널은 정확한 오류 코드와 함께 영구 실패로 남긴다. 신규 게시나 파일 업로드의 5xx, 타임아웃과 응답 유실은 상대편 반영 여부를 모르는 상태이므로 `DEAD_LETTER`와 `SLACK_DELIVERY_OUTCOME_UNKNOWN` 사유를 남겨 자동 재게시를 중단한다. 메시지 ID가 확인된 편집은 같은 메시지를 대상으로 재시도한다. 비밀값, 요청 헤더와 응답 전체를 로그에 남기지 않는다.

`providerMessageId`에는 Slack 메시지의 `ts`를 문자열 그대로 저장한다. 정정은 `chat.update`를 사용한다. 실제 `message_not_found`일 때만 새 게시를 허용하고, 권한 실패를 새 게시로 우회하지 않는다. `NotificationDelivery`에는 선택적인 provider receipt JSON을 추가해 파일 업로드 진행과 확인된 Slack 파일 ID를 보존하며, 재처리 때 이미 확정된 업로드를 반복하지 않는다. 파일 업로드와 메시지 게시의 부분 성공, 응답 유실 시 중복 위험도 테스트한다. 결과가 불명확한 경우 성공으로 기록하지 않으며, 채널 readback 없이 재게시하지 않는다.

기존 Discord 보존 작업은 `DISCORD` 조건을 유지한다. Slack 무료판은 최근 90일 열람과 최대 1년 보관 제한을 따른다. 사용자 리뷰를 포함하는 Slack 게시물에는 기존 리뷰 원문 만료와 같은 삭제 절차를 적용한다. 서비스별 삭제 확인 전에 원문 만료 처리를 성공으로 간주하지 않는다. 일반 Slack 메시지의 임의 일괄 삭제는 하지 않는다.

## 인수조건과 테스트

| 조건 | 개발 환경 검증 |
| --- | --- |
| AC-1 신규 대상 이벤트만 Slack 대기 기록을 얻는다 | 최초 enqueue, 중복 enqueue, 과거 이벤트, 허용되지 않은 목적지 테스트 |
| AC-2 Discord 실패와 Slack 실패가 서로 전송 상태를 바꾸지 않는다 | 서비스별 claim과 실패, 중복 worker, 정정 중 재처리 테스트 |
| AC-3 메시지 게시와 편집 결과를 실제 응답으로 판정한다 | HTTP 200의 `ok:false`, 429, 5xx, timeout, 권한 부족과 삭제된 메시지 테스트 |
| AC-4 보고 내용과 첨부가 보존된다 | 대표 지표, 리뷰, 장애, 작업 결과 fixture의 본문과 링크, 이미지와 CSV 검사 |
| AC-5 명령과 승인을 실행할 수 없다 | 승인 payload 제외, 봇 scope와 앱 manifest 확인 |
| AC-6 기존 보존 기준을 지킨다 | Slack 리뷰 만료, provider별 메시지 ID 분리와 Discord 삭제 경로 회귀 |
| AC-7 실제 도착이 확인된다 | 지정 Slack 채널에 검증 메시지 1건 게시와 수정, 채널 화면과 메시지 ID readback |
| AC-8 운영 적용이 확인된다 | 후보 SHA, migration, 웹과 worker의 이미지 digest, Slack 설정과 이후 신규 실제 보고 readback |

테스트 계획은 같은 폴더의 `test-plan.json`이다. L1 개발 환경과 서비스 런타임으로 실행한다. 앱 화면과 모바일 네이티브 코드는 변경하지 않는다. 사용자의 모바일 사용성 평가는 선택이며 기기 접근을 요청하지 않는다. pure logic과 전송 경계는 실패 테스트부터 구현하고, 외부 앱 등록은 manifest 대조와 provider readback으로 검증한다. `pnpm typecheck`, `pnpm lint`, `pnpm build`, 관련 테스트와 migration 안전 검사, 중앙 개발 근거 검증을 수행한다. 검증기가 추가 개발 환경 회귀를 요구하면 추가 실행한다.

## 적용과 복구

설계 승인 → 실행 Issue → 테스트와 구현 → 로컬 리뷰 → 한국어 Ready PR → 필수 검사와 병합 → 정확한 후보의 호환 migration과 서비스 배포 → 웹과 알림 worker readback → 검증 메시지와 최초 신규 실제 보고 확인 순서로 진행한다. 실행은 `service` 공개 운영까지 계획한다. 기존 앱의 마켓 출시나 심사 제출은 포함하지 않는다.

Slack 목적지 추가는 기본 비활성 상태로 배포하고, 계정과 scope, 봇의 채널 참여, migration과 전송 검증을 통과한 뒤 대상 목적지만 활성화한다. 오류가 나면 신규 Slack 대기 생성과 Slack 소비만 중지하고 Discord는 유지한다. 이미 기록한 이벤트와 배달 이력, 기존 Secret은 삭제하거나 되돌리지 않는다. 모든 worker가 provider를 구분한 버전인지 확인하기 전에는 Slack 대기 기록을 생성하지 않는다.

## 대안과 추적

수신 전용 웹훅은 빠르지만 메시지 편집과 파일 전달을 위해 다시 구성해야 하므로 봇 앱을 사용한다. Discord를 즉시 중단하면 사용 중인 승인과 명령이 끊기므로 시험 이후 별도 전환 설계에서 정리한다. 이는 완료 조건이 있는 시험 단계이며 신규 provider와 outbox 경계는 이후에도 같은 구현을 사용한다.

승인 커밋, 실행 Issue와 PR, 검증과 provider readback은 확인된 뒤 이 폴더에 연결한다. 현재 문서는 구현 승인이나 운영 배포 완료를 주장하지 않는다.

공식 근거: [앱 manifest](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/), [메시지 게시 권한](https://docs.slack.dev/reference/scopes/chat.write/), [메시지 갱신](https://docs.slack.dev/reference/methods/chat.update/), [무료판 제한](https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces).
