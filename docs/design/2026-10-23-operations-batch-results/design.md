# 서비스 배치 결과와 수집 검증 운영알림

상태: 구현 전 검토안. 사용자의 세 가지 요청과 ‘실패와 복구 즉시, 전체 결과 매일 오전 9시’ 선택을 반영했다. 승인 뒤 구현과 L1 검증, Ready PR, 병합, 운영 반영과 실제 Discord 조회까지 진행한다.

기준 소스: 234ae1d02b1f11ae4e197abe0f7528ae6b6cb84d.

## 보고할 내용과 범위

| 종류 | 운영알림 채널에 보낼 때 | 확인할 내용 |
| --- | --- | --- |
| Amazon KDP | 새 판매, 환불 또는 기존 데이터 정정 | 책과 기준 월, 이전 값과 현재 값, 판매량과 예상 로열티. 동일 데이터 재수집은 발송하지 않는다. |
| 앱인토스 지표 | 실제 수집 직후 | 리스팅과 기간, 저장 건수와 실제 행 재조회 검증 건수, 불일치, 결측, 조회와 저장 오류, 최신 날짜. 부분 수집을 전체 성공으로 표시하지 않는다. |
| 일반 서비스 배치 | 실패와 복구 시 즉시, 전체는 매일 09:00 KST | 관측한 실행의 성공, 실패, 진행 중 상태와 확인 불가 구간, 실패 작업과 필요한 조치. 재시도나 중복 관측을 더하지 않는다. |

배치의 정상 종료와 수집 데이터의 검증 결과는 별도 사실로 표시한다. 일일 요약은 전날 09:00부터 당일 09:00까지를 기준으로 한다. 개인피드 목적지와 내용, 주기는 변경하지 않는다.

현재 Kubernetes 관측에서 platform 30개, data 2개, container-registry 1개, 총 서비스 CronJob 33개를 확인했다. tasks의 7개 CronJob은 cronjobs 저장소에서 private-feed로 정의돼 있으므로 감시, 장애 알림, 일일 집계에서 모두 제외한다. tasks의 북센과 교보문고 판매 작업도 이 개인피드 제외 범위에 해당한다. 별도의 로컬 KDP 작업은 포함한다.

## 구조와 실패 처리

기존 SourceCollectionRun과 NotificationEvent, NotificationDelivery, OperationalIncident를 재사용한다. DB migration과 새 봇, 새 webhook, 새 자격증명은 없다.

1. KDP 저장과 이전 관측 비교, 변경 알림 대기열 등록을 같은 DB transaction에서 처리한다. 보고서 파일의 해시나 수집 시각만 바뀌면 알리지 않는다. 늦게 도착한 과거 관측과 재전송은 최신 변경 알림을 만들지 않는다. 실제 금액과 수량은 통화별로 유지한다.
2. 앱인토스는 방금 수집한 리스팅과 날짜의 행을 다시 읽고 제공된 지표 값과 수집 시각을 대조한다. 과거에 같은 최신 날짜가 있었다는 이유만으로 검증 성공으로 세지 않는다. 기존 수집 결과 알림을 운영알림 목적지로 옮기고, 사용자 요청 결과로 명시해 현재의 자동 관측 알림 억제 정책과 구분한다.
3. 새 전용 감시 CronJob이 1분마다 세 운영 namespace의 CronJob과 Job 상태만 읽는다. 개인피드 namespace에는 접근 권한을 부여하지 않는다. 전용 ServiceAccount에는 batch Job과 CronJob의 get, list만 주며 Secret, Pod, 로그와 리소스 변경 권한은 주지 않는다. Kubernetes token과 기존 내부 API 토큰은 메모리에서만 사용한다.
4. Job UID로 실행 이력을 중복 없이 기록한다. 재시도 중 Pod 실패를 최종 Job 실패로 판정하지 않고, Job의 종료 조건으로 성공과 실패를 판단한다. 같은 작업의 후속 성공을 복구로 기록하며 늦게 관측한 과거 실패가 현재 복구 상태를 되돌리지 않게 한다.
5. 실패와 복구는 기존 장애 카드와 outbox 재시도를 사용한다. 일일 요약은 KST 보고 날짜로 한 번 생성한다. 감시 중단이나 보관 기간 때문에 확인하지 못한 구간은 미확인으로 남기며 성공이나 0건으로 표시하지 않는다. 첫날의 감시 시작 이전 구간도 전체 검증으로 세지 않는다.
6. 로컬 KDP는 한 실행의 시작과 종료, 월별 성공과 실패를 같은 배치 기록 경로로 보낸다. 서버 자체에 연결할 수 없으면 로컬 실패를 남기며 서버에 기록됐다고 주장하지 않는다. 장시간 실행 중 또는 예정 수집이 미확인인 경우 요약에 구분한다.

## 적용과 복구

Backoffice 웹과 알림 worker는 기존 명시 배포 절차와 immutable 이미지로 반영한다. 새 감시자의 읽기 전용 RBAC는 등록된 운영자 identity로 적용하고 기존 CI 권한은 확대하지 않는다. 감시 CronJob의 이미지는 기존 배포 과정에서 같은 후보로 갱신한다. 앱인토스의 운영 CronJob도 같은 후보 이미지로 갱신하며 현재 6시간 간격은 유지한다.

로컬 KDP는 기존 설치 SHA와 파일 해시, 예약 작업 소유권을 확인한 뒤 새 SHA 설치로 전환한다. 원래 09:00 일정과 인증 프로필을 보존하고 전환 실패 시 이전 설치로 복구한다. 기존 사용자 설정이 다르면 덮어쓰지 않는다.

## 인수조건과 테스트

L1 개발 환경에서 다음을 실행한다. 새 웹 화면, 기기 실행과 UI 개편은 없다.

- KDP 변경, 정정과 되돌림, 동일 데이터와 파일 해시만 변경, 재전송, 동시 수집과 늦은 관측의 알림 여부.
- 앱인토스의 값 일치, 행 누락과 불일치, 오래된 수집 시각, 결측과 부분 저장, 전체 실패와 발송 실패. 숫자를 임의의 0으로 바꾸지 않는다.
- 서비스 namespace 포함과 개인피드 제외, Job 재시도와 최종 실패, 복구, 순서 역전과 중복, 진행 중과 관측 공백, KST 09:00 경계와 일일 보고 중복 방지.
- 감시자 권한과 발송 정책, 비밀값이 요청 결과와 로그에 나오지 않는지, KDP 설치 전환과 복구.
- typecheck, lint, 전체 테스트, build와 중앙 개발 근거 검증. 필요 시 격리 MySQL과 Discord HTTP fixture로 실제 저장과 outbox 전송을 검증한다.
- 운영에서는 실제 수집과 데이터 재조회, outbox의 SENT와 providerMessageId, Discord 운영알림 채널 본문을 따로 확인한다. 가짜 판매 데이터를 운영에 만들지 않는다. 자연 판매 변동 알림과 다음 09:00 자연 예약 실행은 관측 전까지 미확인으로 남긴다.

승인은 이 설계와 같은 폴더의 test-plan.json 전체를 대상으로 받는다. 배포 범위는 Backoffice service, 운영 감시 CronJob과 읽기 전용 RBAC, 기존 앱인토스 CronJob 이미지와 로컬 KDP 예약 실행기의 갱신이다. 개인피드와 판매처 계정 변경은 포함하지 않는다.

## 조사한 예약 작업

| namespace | 작업 | 분류 |
| --- | --- | --- |
| container-registry | registry-safe-gc | 서비스 운영 포함 |
| data | backoffice-provider-audit-trigger-verify | 서비스 운영 포함 |
| data | vault-writer | 서비스 운영 포함 |
| platform | backoffice-ait-console-metrics | 서비스 운영 포함 |
| platform | backoffice-analytics-collect | 서비스 운영 포함 |
| platform | backoffice-analytics-recollect | 서비스 운영 포함 |
| platform | backoffice-analytics-report | 서비스 운영 포함 |
| platform | backoffice-app-content-analytics-collect | 서비스 운영 포함 |
| platform | backoffice-automation-scheduler | 서비스 운영 포함 |
| platform | backoffice-daily-digest | 서비스 운영 포함 |
| platform | backoffice-db-backup | 서비스 운영 포함 |
| platform | backoffice-desired-state-backfill | 서비스 운영 포함 |
| platform | backoffice-extended-metrics | 서비스 운영 포함 |
| platform | backoffice-finance-report | 서비스 운영 포함 |
| platform | backoffice-fleet-project-projection | 서비스 운영 포함 |
| platform | backoffice-godot-version-check | 서비스 운영 포함 |
| platform | backoffice-keyword-daily | 서비스 운영 포함 |
| platform | backoffice-market-feedback | 서비스 운영 포함 |
| platform | backoffice-metric-daily-reconcile | 서비스 운영 포함 |
| platform | backoffice-metric-highlights | 서비스 운영 포함 |
| platform | backoffice-metric-landing-probe | 서비스 운영 포함 |
| platform | backoffice-metric-report-prepare | 서비스 운영 포함 |
| platform | backoffice-operations-report | 서비스 운영 포함 |
| platform | backoffice-platform-metric-collect | 서비스 운영 포함 |
| platform | backoffice-realtime-spike | 서비스 운영 포함 |
| platform | backoffice-reconcile | 서비스 운영 포함 |
| platform | backoffice-registry-seed | 서비스 운영 포함 |
| platform | backoffice-repository-discovery-backfill | 서비스 운영 포함 |
| platform | backoffice-store-reviews | 서비스 운영 포함 |
| platform | backoffice-store-submissions | 서비스 운영 포함 |
| platform | backoffice-weekly-insights | 서비스 운영 포함 |
| platform | backoffice-weekly-liveops | 서비스 운영 포함 |
| platform | backoffice-xcode-cloud-sync | 서비스 운영 포함 |
| tasks | career-briefing | 개인피드 제외 |
| tasks | daily-briefing | 개인피드 제외 |
| tasks | grant-briefing | 개인피드 제외 |
| tasks | growth-developer-book-sales | 개인피드 제외 |
| tasks | songpa-jamsil-weather | 개인피드 제외 |
| tasks | trends-news | 개인피드 제외 |
| tasks | weekend-briefing | 개인피드 제외 |

근거: 최신 수집기와 발송 정책 소스, Kubernetes 실제 CronJob 조회, fundevel/cronjobs README의 private-feed 계약. 현재 앱인토스 알림은 metrics-daily를 지정하고 report-policy의 legacy 수집 알림 억제 규칙에 포함돼 있다.
