# Discord 생산자·전송 경로 초기 조사

- 조사자: 독립 판단 품질 검수 담당
- 기준 소스: `2a83f7e7c898e07909393d2e11dd6e5afc6348f2`
- 조사 범위: 저장소 `src/`, `scripts/`, `k8s/`, `.github/`의 자동 생산자, 사용자 요청 응답, 직접 Discord API 호출, 외부 ingest
- 실행: 읽기 전용 소스 조사. 운영 DB 조회·Discord 전송·사용자 데이터 변경 없음.
- 상태: 구현 전 경로 목록이다. 사용자 승인 계획의 독립 실행 검수 1회차로 세지 않는다. 실제 배포·CronJob 활성 여부는 이 문서로 증명하지 않는다.

## 공통 경로

| 경로 | 현재 동작 | 변경할 판단 |
| --- | --- | --- |
| `notifications/outbox.ts:25` → `deploy.ts:298` → `discord.ts:205` | 생산자마다 `NotificationEvent`와 delivery를 만들고 워커가 전송한다. 중복 키는 같은 사건 재전송만 막고, 사람에게 유용한지 검사하지 않는다. | 관측 원장을 보존하면서 보고 선정과 분리한다. 과거 대기 메시지도 같은 기준으로 검사한다. |
| `notifications/outbox.ts:119` | 모든 만기 `PENDING`을 가져온다. `PROCESSING` 회수, 재시도와 `DEAD_LETTER`는 있으나 발송 제외 상태가 없다. | `SUPPRESSED`와 사유를 별도로 남기고 성공으로 세지 않는다. |
| `insights/service.ts:97,185,412` | 모든 operational signal에 분석 작업과 최초 사실 알림을 함께 만든다. 분석 완료 때 같은 알림을 다시 대기시킨다. | 선정되지 않은 관측은 내부 기록으로 남긴다. 분석 진행·실패를 발송 이유로 삼지 않는다. |
| `insights/service.ts:46` | `failure`, `recovery`, `stale` 이름이 들어가면 `ops-alerts`로 보낸다. 수집 실패도 이 규칙에 들어간다. | 실제 사용자 영향 사건과 자료 수집 상태를 구분한다. |
| `insights/contract.ts:27,69,113,166` | 3~5개 불릿에 `fact`, `hypothesis`, `action`을 모두 요구한다. 분석 전에는 ‘해설 준비 중’, 실패 때는 ‘해설 없음’을 표시한다. | 앱·결론, 중요한 비교 근거, 의미, 필요한 행동 순서로 바꾼다. 행동이 없으면 만들지 않는다. |
| `notifications/deploy.ts:339` | `org-trend` 이미지는 전송할 때 DB에서 다시 생성한다. | 보고 본문과 그래프의 기준 스냅샷을 고정한다. |

## 자동 생산자

아래 경로는 모두 `src/lib/` 기준이다. 라우트는 `src/app/` 기준으로 적었다. ‘내부 기록’ 분류도 관측·감사 원장 보존을 전제로 한다.

| 영역·생산자 | 현재 채널·동작 | 분류와 변경 필요 |
| --- | --- | --- |
| `market/collector.ts:156` 공개 평점 | 평균 평점 0.1점 차이 또는 평점 수 10개 차이로 `review-rating-change`를 발행한다. `user-reviews`로 간다. | **내부 기록.** 평균 차이 조건에 최소 표본이 없어 평점 수 2→3개, 평균 1→2점도 개별 카드가 된다. 평점만으로 가설을 만들지 않는다. |
| `store-reviews/collector.ts:204`, `shape.ts:96` | 최초 baseline 뒤 새 리뷰·수정 리뷰마다 원문과 평점을 즉시 `user-reviews`에 발송한다. 원장에는 본문 대신 hash와 평점이 남고, 본문은 알림 payload에 있다. | **보고.** 실제 불편·요청·칭찬을 앱·버전·국가별로 묶어 판단할 수 있어야 한다. 원문 없는 별점 변경은 보고 근거가 약하다. |
| `insights/triggers.ts:56`, `review-groups.ts` | 기존 `STORE_REVIEW` 이벤트를 15분 창으로 다시 묶어 개수·수정 수·낮은 평점 수를 보낸다. ‘원문 분석 제외’를 명시한다. | **보고 경로 통합.** 원문 알림 뒤 숫자만 다시 보고하는 이중 경로다. 반복 주제와 실제 내용을 담아야 한다. |
| `store-reviews/submissions/persist.ts:76,142` | 공식 관측의 실제 상태 전환만 `release-ops`에 발송한다. Play 첫 정상 관측은 baseline, 비정상 응답은 `UNAVAILABLE`로 구분한다. | **보고 유지.** 앱·버전·마켓·실제 전환과 필요한 결정을 앞에 둔다. 승인과 공개를 계속 구분한다. |
| `insights/triggers.ts:155` 심사 상태 | 같은 submission 관측을 다시 `submission-approved`, `submission-rejected`, `published` 신호로 발행한다. | **보고 경로 통합.** 기존 심사 상태 카드와 동일 사건 중복을 없앤다. |
| `market/collector.ts:183` 공개 리스팅 | 앱 버전이 보이면 앱·국가·버전 키로 `public-listing-confirmed`를 만든다. | **보고.** 공개 관측 근거는 유지하되 동일 버전·마켓의 다른 경로와 묶는다. |
| `insights/triggers.ts:264,299` 출시 후 관측 | 공개 후 +1/+3/+7일의 DAU 한 개만으로 `release-impact`를 발행한다. | **내부 기록.** 비교 기간·표본이 없는 단순 DAU는 개별 보고에서 제외한다. |
| `notifications/deploy-enqueue.ts:16,36`, `sync/mirror.ts:318,342`, `xcode-cloud/release.ts:98`, `xcode-cloud/status.ts:67` | workflow 결과와 Xcode Cloud 상태를 출시 카드로 발송한다. `deploy.ts`가 현재 release record를 다시 읽고 카드 수명주기를 편집한다. | **보고 유지.** 빌드·업로드·처리·심사·공개를 합치지 않는다. 같은 버전·마켓의 동일 결론을 중복 전송하지 않는다. |
| `analytics/console-sync/notification.ts:14,58` | 앱인토스 수집 성공·부분·실패마다 반영 수, 리스팅 수, 오류·누락·보류 수와 각 리스팅 목록을 `metrics-daily`에 보낸다. | **내부 기록.** 사용자 개입이 필요한 구체적 영향·조치가 확인된 경우만 별도 보고한다. 수집 성공 자체는 보고가 아니다. |
| `insights/triggers.ts:87,117,190` 수집 상태·회복 | 수집 실패 뒤 성공, Play 60분 지연, 그 밖의 `failed/stale/needs_input`을 자동 신호로 발행한다. | **내부 기록.** 범용 수집 실패·회복 횟수를 장애 채널에 보내지 않는다. 실제 사람 조치가 필요한 상황은 별도 근거로 선정한다. |
| `market/daily-ranks.ts:19,39` 일일 검색 순위 | 앱·조합·수집 수가 본문 중심이며 이동량 절댓값 최대 5개를 고른다. 목록 밖을 정렬 계산에서 201로 취급한다. CSV를 첨부하고 변화가 없어도 보낸다. | **보고.** 상위 10·20·50·100 진입·이탈과 지속 추세를 먼저 고른다. 최대 3개 결론·실제 데이터 이미지·같은 기준일 웹 상세로 바꾼다. 목록 밖은 정확한 201위로 그리지 않는다. |
| `market/collector.ts:222` 검색 변화 | 일일 순위표와 별개로 `keyword-change` 카드를 발행한다. | **보고 경로 통합.** 같은 앱·국가·검색어·기간 결론을 이중 전송하지 않는다. 추가로 중요한 근거가 생겼을 때 추가 보고한다. |
| `market/collector.ts:98` 지원 링크 | HTTP 400 이상이면 `support-failure`를 발행한다. | **사건 또는 보고.** 사용자 접근 불가를 실제 확인한 근거인지 드러내고, 수집기 접근 오류와 구분한다. |
| `market/collector.ts:278,323` 경쟁 앱·정책 | 경쟁 앱 버전 변경과 공식 정책 feed 새 글을 각각 발행한다. | **보고.** 어떤 앱·작업에 영향을 주는지 없으면 내부 관측으로 남긴다. 새 글·새 버전 자체로 범용 행동을 만들지 않는다. |
| `core/operations-report.ts:9,64,99` | 22:30 당일 이벤트 종류별 원시 합계와 Platform 활성 현황, Play 수집 실패·부분·회복 횟수를 `app-ops`에 보낸다. | **내부 기록/종합 보고로 통합.** 수집 횟수와 원시 성공 합계는 일일 보고에서 제거한다. |
| `core/analytics-report.ts:354,442` | 앱별 DAU 등 수치 표와 수집 없는 앱 목록, 앱인토스 수집 구간을 별도 일일 메시지로 보낸다. Vault 원본도 쓴다. | **종합 보고로 통합.** 관측 원본·Vault 기록은 유지하고 중요한 비교·우선순위를 중심으로 보고한다. |
| `core/metric-highlights.ts:714`, `core/org-report.ts:291,397` | 기존 기준선·표본·변화량 판단으로 종합 하이라이트를 보내며 같은 날짜는 편집·정정한다. 이미지가 있다. | **보고 기반 재사용.** 중요한 지표 판정은 재사용한다. 다른 일일 경로와 중복 결론 및 수집 상태 중심 서술을 제거한다. |
| `insights/triggers.ts:238,334` | 하이라이트의 주요 변화마다 개별 숫자 카드도 보내고, 주간은 보고서 날짜 수·리뷰 수·마지막 날 활성 합계로 별도 발행한다. | **보고 경로 통합.** 비교 기간·추세·표본을 보존한다. 수집 범위와 마지막 날 숫자만으로 추가 보고를 만들지 않는다. |
| `core/finance-report.ts:47`, `insights/triggers.ts:207` | 일일 월 누적 비용·경고 없음도 `app-ops`에 보내며, 같은 비용 경고가 인사이트 신호로도 발행된다. | **보고.** 중요한 비용 변화·한도·판단을 중심으로 종합하고 같은 경고 중복을 없앤다. |
| `analytics/anomalies.ts:25,46` | 기준선 DAU 20 이상에서 60% 이상 하락, 광고 완료 20 이상인데 네트워크 노출 0이면 incident를 만든다. | **제품 변화 보고/확인된 장애 구분.** 단일 지표 이상을 서비스 이용 불가 확정으로 표시하지 않는다. 기존 표본·기준선을 보존한다. |
| `notifications/incidents.ts:60,74,120` | 사건 발생·확인·담당·회복을 원장과 같은 Discord 카드 편집으로 관리한다. 본문은 상태와 시각 중심이며 evidence는 렌더하지 않는다. | **긴급 사건 유지.** 앱·사용자 영향·확인된 증거·조치를 카드에 드러낸다. 신고와 실제 확인을 구분한다. |
| `app/api/internal/platform/operational-events/route.ts:85,100` | 결제 완료·광고 보상 실패마다 incident와 전용 채널 카드 둘 다 만들고, 이후 `triggers.ts:176`가 service-failure 신호도 만든다. | **긴급 사건 경로 통합.** 실제 지급 문제는 유지하며 동일 사건 2~3경로 반복을 제거한다. |
| `notifications/iap-summary.ts:195,226,247` | 결제 지급마다 앱·일 요약을 편집하고 건별 독립 카드도 보낸다. 테스트·실거래·미확인 3상태를 보존한다. | **반복 성공은 내부 기록.** 첫 실제 성과와 의미 있는 변화만 맥락과 함께 보고한다. 테스트 성공을 실제 성과로 세지 않는다. |
| `notifications/identity-summary.ts:187,229,248` | 신규 계정마다 일일 요약을 편집하고 한 줄 개별 기록을 `action-events`에 보낸다. | **반복 성공은 내부 기록.** 첫 성과·의미 있는 변화만 보고한다. |
| `notifications/milestones.ts:30,66` | 앱 생애 첫 계정은 별도 축하 메시지를 만든다. 첫 IAP·광고 보상은 원장만 남긴다. | **첫 성과 보고.** 계정 요약·단건과 중복을 줄이고 실제 성과 여부를 분명히 한다. |
| `app/api/internal/platform/operational-events/route.ts:135`, `platform/operational-events.ts:169` | 광고 보상 성공을 건마다 카드로 발행하고, 새 앱 버전 첫 유입 등도 개별 줄로 보낸다. | **반복 성공은 내부 기록.** 버전 첫 유입은 실제 변화·작업 영향이 있을 때만 보고한다. |
| `ga4/realtime-spike.ts:31,110` | 최소 12개 표본, 현재 10명 이상·평소 3배 이상이 두 번 이어지면 `app-ops`에 급증 보고한다. | **중요 변화 보고 유지.** 비교 기간과 지속 시간·의미를 분명히 한다. 단순 매 샘플 발송은 없다. |
| `notifications/proactive.ts:38` 단계 넛지 | QA/등록/릴리스/운영 단계 진입 때 자료 생성 버튼을 제안한다. | **상태만으로 보내는 제안은 내부 기록.** 이미 요청된 작업 결과·실제 필요한 결정과 연결한다. |
| `notifications/proactive.ts:68,140` 다이제스트·주간 운영 | 매일 승인 수·P1 수·병합 수·단계 수, 매주 운영 앱 수와 ‘개선 가설 만들기’ 버튼을 보낸다. | **보고/승인 요청.** 실제 바뀐 작업·제품 영향과 필요한 판단을 중심으로 묶는다. 상태 반복·빈 보고는 제외한다. |
| `app/api/webhooks/route.ts:83,102,190` GitHub | 승인 라벨, 모든 이슈 생성·종료, 원문·관련 PR 쓰레드를 발행한다. 중복 기준은 webhook delivery ID다. | **승인 요청 유지/개발 보고 선정.** 승인 대상·결과·조작은 분명히 유지한다. 개발 이슈는 앱·작업 영향과 결론이 있어야 보고한다. 동일 사건 다른 delivery ID 중복도 확인한다. |
| `godot/version-check.ts:73,98` | pin보다 높은 Godot stable을 발견하면 버전과 변경 대상 파일 목록을 보낸다. 버전 키로 중복을 막는다. | **개발 보고.** 영향 앱·작업과 실제 변경점을 확인할 수 있을 때 보고하고 원문 링크는 유지한다. |
| `deployment-approvals/monitor.ts:8,12,38,73` | 실제 GitHub 배포 승인 대기 카드·재알림, 조회/전송 실패를 `ops-alerts`에 보낸다. | **승인 요청 유지.** 실제 차단 대상과 필요한 조치는 보고한다. 단순 provider 조회 실패를 사용자 앱 장애로 오해하게 하지 않는다. |
| `notifications/external-ingest.ts:20,33` | NATS `ops.notification.v1.private-feed`, `.seori-review`의 외부 본문·첨부·쓰레드를 검증 후 그대로 큐에 넣는다. 중복 키는 외부 source/id다. | **외부 보고 선정 필요.** 현재는 내용의 의미·근거·영향 모델이 없고 길이/형식만 검증한다. 외부 원문·실행 로그는 링크로 제공한다. |

## 스케줄과 상시 워커

시각은 매니페스트의 UTC crontab을 KST로 환산했다. 저장소의 `suspend` 기본값은 운영 활성 여부가 아니다.

| 실행 | 저장소 스케줄 | 근거 |
| --- | --- | --- |
| 알림 전달·외부 NATS ingest | 상시, 기본 1초 poll | `scripts/notification-worker.ts:15,35,55`, `k8s/discord-workers.yaml:4` |
| 인사이트 신호 발견·분석 | 상시, 발견 60초 간격 | `scripts/operations-insights-worker.ts:30`, `k8s/operations-insights-worker.yaml:5` |
| 일일 공장 다이제스트 | 매일 09:00 KST | `k8s/proactive-cronjobs.yaml:11` |
| 주간 운영 제안 | 월요일 09:00 KST | `k8s/proactive-cronjobs.yaml:54` |
| 재무 보고 | 매일 09:00 KST | `k8s/proactive-cronjobs.yaml:281` |
| Godot 버전 | 월요일 10:00 KST | `k8s/proactive-cronjobs.yaml:188` |
| 시장 수집 | 매일 21:20 KST, 파일 기본 `suspend: true` | `k8s/market-feedback-cronjobs.yaml:93,96` |
| 검색 순위 보고 | 매일 21:40 KST, 파일 기본 `suspend: true` | `k8s/market-feedback-cronjobs.yaml:296,299` |
| 운영 원시 집계 | 매일 22:30 KST | `k8s/proactive-cronjobs.yaml:236` |
| 앱 지표 별도 요약 | 매일 23:30 KST | `k8s/proactive-cronjobs.yaml:143` |
| 종합 보고 정정·발행 | 매일 23:45·23:50 KST | `k8s/proactive-cronjobs.yaml:423,329` |
| 주간 인사이트 | 월요일 10:30 KST, 파일 기본 `suspend: true` | `k8s/market-feedback-cronjobs.yaml:184,187` |
| 앱인토스 수집 후 알림 | 매일 06:30 KST | `k8s/console-metrics-cronjob.yaml:13`, `scripts/console-metrics-collector.ts` |
| 심사 상태 관측 | 15분 간격 | `k8s/store-submissions-cronjob.yaml:12` |
| 리뷰 관측 | 30분 간격 | `k8s/store-review-cronjob.yaml:12` |
| 실시간 사용자 급증 관측 | 5분 간격 | `k8s/realtime-spike-cronjob.yaml:11` |
| GitHub·Xcode 상태 재관측 | reconcile 6시간, Xcode 1분 | `k8s/scheduler-cronjobs.yaml:157,299` |

GA4 수집·재수집·landing probe, Android Vitals, Platform 지표 수집은 원장 생산자다. 그 자체의 Discord 직접 전송은 발견하지 못했으나 수집 원장과 지표 원장을 읽는 위 인사이트·보고 경로가 간접 발송한다.

## 사용자 요청 응답과 직접 호출

| 경로 | 분류·검증 경계 |
| --- | --- |
| `discord/handler.ts`, `command-definitions.ts`, `queries.ts`, `insight-queries.ts` | **사용자 요청 응답.** 현황·지표·보고서·리뷰·검색어·수집 상태·인사이트·승인·긴급 이슈 조회는 요청 결과다. 자동 보고 억제 기준으로 지우면 안 된다. |
| `discord/command-runs.ts:190` | **사용자 요청 응답.** 긴 작업의 결과를 `editDiscordChannelMessage` 또는 `createDiscordChannelMessage`로 직접 보여 준다. 초안·등록·배포·스냅샷·노트·대화 명령 결과와 버튼 회귀가 필요하다. |
| `discord/deferred-read.ts:22` | **사용자 요청 응답.** Discord 3초 제한을 피한 deferred 결과를 interaction webhook PATCH로 돌려준다. 자동 보고 우회 경로가 아니다. |
| `discord/interaction-cleanup.ts:26` | **사용자 요청 응답 정리.** 원래 interaction 메시지 삭제를 위한 직접 webhook 호출이다. 자동 발송이 아니다. |
| `deployment-approvals/delivery.ts:10` | **승인 카드 전달.** `deploy.ts`에서 호출하는 전용 카드 renderer이며 별도 자동 생산자는 아니다. |
| `notifications/discord.ts` | **공통 전송.** 메시지 생성·편집·첨부·쓰레드·삭제 API를 담당한다. |
| `core/general-issue-access.ts:28`, `deployment-approvals/execute.ts` | Discord 회원·역할 조회다. 메시지 생산 경로가 아니다. |

## 외부 경로와 누락 점검

1. `src/`, `scripts/`, `.github/`에서 `notifications/outbox`·`notifications/discord` import, `notificationEvent.create/upsert`, 메시지 생성·편집 함수, Discord URL, Telegram URL을 역검색했다. 공통 전송과 interaction 응답 외의 raw Discord POST/외부 webhook 전송은 발견하지 못했다. GitHub Actions에서 Discord로 직접 보내는 경로도 발견하지 못했다.
2. 외부 NATS ingest는 저장소 안에서 경계까지 확인했다. upstream 생산자는 이 저장소에 없으며 `docs/DEPLOY.md:661`도 이를 명시한다. 저장소 밖에서 Discord로 직접 보내는 프로그램·webhook 존재 여부는 이 조사로 확인할 수 없다. 운영 적용 시 실제 채널의 발신자·NATS 소비·관련 외부 배포를 대조해야 한다.
3. 알림 보존 정리(`notifications/retention.ts`)는 기존 메시지 삭제 경로이며 신규 보고 생산자는 아니다. 이번 변경에서 이미 발송된 과거 메시지의 일괄 수정·삭제를 새로 실행해서는 안 된다.
4. `NotificationKind`를 여러 용도에 재사용하므로 kind만으로 보고를 억제하면 승인·실제 장애를 함께 지울 수 있다. `OPS_ALERT` 안에 승인·재무·GitHub·검색·인사이트가 섞여 있고, `STORE_REVIEW` 안에 사용자 리뷰와 심사 전환이 함께 있다.

## 구현 뒤 판단 품질 검수의 최소 사례

- 소모수 평점 수 2→3개, 평균 1→2점: 원장은 남고 자동 개별 보고는 없음.
- 수집 성공·부분·실패·일시 회복과 횟수: 내부 기록만 남고 앱 장애로 발송되지 않음.
- 공개 +1/+3/+7일 단일 DAU: 비교 없는 개별 보고 없음.
- 동일 앱·기간·주제의 재처리: 같은 결론을 새 메시지로 보내지 않음. 중요한 새 영향·근거·결정은 보고 가능.
- 결제/광고 보상 지급 실패: 앱과 실제 영향·조치를 읽을 수 있는 사건은 보존하고 중복 경로는 없음.
- 승인 요청과 사용자 명령 결과: 대상·결과·다음 조작이 유지됨.
- 표본·기준선이 충족된 중요한 지표/검색 순위 변화: 비교 기간·단위·국가·검색어와 근거 링크를 읽을 수 있음.
- 테스트·실제·미확인 결제: 섞어 성과로 보고하지 않음.
- 과거 대기 메시지: 새 기준으로 `SUPPRESSED`와 사유가 남고 `SENT`로 세지 않음.

위 항목은 소스 조사에서 도출한 실행 인수조건이다. 구현 후보의 실제 격리 서비스 런타임 실행 결과는 별도 검수 기록에 적는다.

## 외부 경계 후속 확인

`/Users/syous/Repositories/seorilabs/gemini-pr-bot/src/notifications.ts`의 실제 송신 구현을 읽었다. `source=seori-pr-bot`, `startReviewAudit`의 고정 제목, `notifyReviewAuditEntry`·`notifyMiniMaxResponse`의 thread, `notifyQuotaEvent`의 고정 제목은 자동 감사·처리 원문이다. 이 알려진 출처·형식만 내부로 보낸다. `notifyApproval`의 실제 승인 결과와 구조화 `report.category=response/urgent`는 보존한다. 다른 출처의 문구는 이 규칙으로 분류하지 않는다. 외부 저장소를 수정하거나 배포하지 않았다.

운영 readback에서 12개 채널 최근 최대100건의 발신자를 대조했다. Backoffice·서리 bot이 대부분이고 출시관리에는 별도 Release Ops webhook도 있었다. 이 샘플은 과거 모든 발신 경로나 외부 webhook의 현재 실행 설정을 증명하지 않는다. 운영 적용 전 별도 webhook은 현재 담당 실행과 대조해야 한다.
