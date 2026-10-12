# 콘솔 지표 수집 런북 (온디맨드)

대화형 MCP 조회·push와 승인된 전용 파드 조회가 같은 저장 서비스를 사용한다.
파드 구현은 [승인 설계](../../docs/design/2026-10-12-console-sync-pod/design.md)를 따른다.
**운영 파드는 아직 활성화되지 않았다.** 실제 OAuth 갱신·회전·재시작 확인과 별도 운영 승인 전에는
기존 대화형 수집을 사용한다. 대화형 인증이 만료되면 현재 MCP 설정에서 재인증한다.

## 0. 대상 리스팅

`src/lib/analytics/ait-apps.ts` 의 `AIT_WORKSPACE_ID`, `AIT_LISTINGS`(리스팅 목록)를 정본으로.
수집 단위는 **App 이 아니라 콘솔 리스팅(App × miniAppId)** 이다. 한 App(=repo)이 콘솔에 여러
미니앱으로 등록될 수 있다 — 예: `crossword-puzzle` 는 웹(36555)과 네이티브 게임(56407) 둘. 이런
App 은 같은 `slug` + 다른 `miniAppId` 로 **리스팅마다 별도로 조회·push** 한다. 저장 키는
(appId, miniAppId, date) 이므로 `miniAppId` 는 페이로드에서 **필수**다.

## 1. 수집 구간 (마지막 동기화 기준 증분)

마지막 동기화가 오래됐을 수 있다. 먼저 DB 의 마지막
동기화 상태를 읽고 그 지점부터 당긴다.

```bash
bash scripts/console-metrics/status.sh          # 앱별 lastDate/rows 요약
```

- `endDate` = 어제(D-1, KST).
- `startDate` = `minLastDate` − 2일(재집계 overlap). `minLastDate` 는 데이터가 있는 앱들의
  마지막 저장일 중 가장 이른 값(status 응답). 데이터가 하나도 없으면 `endDate` − 13일.
- `appsWithNoData`(rows=0, 신규 등록 등)는 별도 백필: 그 앱만 출시일부터 당긴다.
- 안전 상한: 한 앱 당 최대 120일(`MAX_DAYS_PER_APP`). 그보다 큰 gap 은 120일씩 나눠 반복.
- 각 MCP 호출은 구간 전체를 한 번에 반환하므로 구간 길이는 호출 수에 영향 없다(멱등 upsert).

## 2. 리스팅마다 MCP 조회 (workspaceId = AIT_WORKSPACE_ID, miniAppId = 리스팅)

- `dashboard_dau` { startDate, endDate, timeUnit:"DAY" }
  → 날짜별 `au[].value`=dau, `newAu[].value`=newUsers. referrer/age/gender/os/appVersion 은 raw.
  - **DAU 배열에 없는 날짜는 0 이 아니라 "콘솔 미집계"다.** 콘솔 DAU 는 식별 가능한 사용자만
    집계해, 세션/광고 활동이 있어도 비로그인 세션이 있는 날은 `au` 에서 키 자체가 빠진다. 그런
    날은 `dau`/`newUsers` 를 **`null`** 로 보낸다(생략도 null 로 저장됨). **0 으로 채우지 말 것** —
    0 은 "방문 0명" 확정을 뜻해 세션/광고가 있는 날엔 허수다. 세션/광고 값은 그대로 채운다.
- `dashboard_session` { startDate, endDate, timeUnit:"DAY" } → 날짜별 `metric[].value`=avgSessionSec.
- `dashboard_revenue_iaa` osType "ANDROID"·"IOS" 각각 { startDate, endDate, osType }
  → 날짜별 `dailyReports[].impression` 합=iaaImpressions, `estimatedEarning` 합=iaaEarningKrw. OS별 상세는 raw.
- `dashboard_revenue_iap` { startDate, endDate, timeUnitType:"DAY" }
  → 날짜별 `trxAmount`=iapTrxAmountKrw, `settlementAmount`=iapSettlementKrw, `pu`=payingUsers. arpu/arppu/pur 은 raw.
- (선택) `dashboard_retention` { ..., dimension:"REFERRER" } → 구간 코호트라 endDate 의 raw.retention 에만.

호출 실패·비정상 응답은 성공 응답의 미집계 날짜와 구분한다. **0으로 채우지 않는다.**
DAU·신규·세션은 정상 응답의 날짜 부재일 때만 null로 둔다. 광고 양 OS의 일별 행,
결제 거래액·정산액·결제 사용자 중 하나라도 확인할 수 없으면 **그 날짜의 행 전체를 제외**한다.
필수 필드를 생략한 행은 ingest가 skip하고 기존 행·관측은 보존한다. 명시적으로 응답한 0은 저장한다.
날짜 중복·비정상 수치·등록된 slug/miniAppId/workspace 불일치도 제외한다.

## 3. 페이로드 (`ConsoleMetricsPush`, console-source.ts)

`apps[]` 의 각 항목은 **리스팅 1개**(slug + miniAppId)다. 다중 리스팅 App(crossword-puzzle)은
같은 slug + 다른 miniAppId 로 **두 항목**을 넣는다. `miniAppId` 는 필수. DAU 미집계일은 `dau`/
`newUsers` 를 `null`(또는 생략)로.

다음은 합성 예시다. 실제 조회에서 확인하지 않은 0을 복사하지 않는다.

```json
{ "apps": [
  { "slug": "happy-farm", "miniAppId": 31877, "workspaceId": 38345,
    "days": [ { "date": "2026-07-16", "dau": 9, "newUsers": 2, "avgSessionSec": 87.7,
                "iaaImpressions": 5, "iaaEarningKrw": 26.9,
                "iapTrxAmountKrw": 0, "iapSettlementKrw": 0, "payingUsers": 0,
                "raw": { "referrer": [], "iaaByOs": {} } },
              { "date": "2026-07-17", "dau": null, "newUsers": null, "avgSessionSec": 30.5,
                "iaaImpressions": 0, "iaaEarningKrw": 0,
                "iapTrxAmountKrw": 0, "iapSettlementKrw": 0, "payingUsers": 0 } ] },
  { "slug": "crossword-puzzle", "miniAppId": 56407, "workspaceId": 38345, "days": [ ... ] },
  { "slug": "crossword-puzzle", "miniAppId": 36555, "workspaceId": 38345, "days": [ ... ] }
] }
```

`/tmp/console-metrics-payload.json` 로 저장.

## 4. Push

```bash
bash scripts/console-metrics/push.sh /tmp/console-metrics-payload.json
```

응답 `{ ok, targetApps, upserts, skipped, errors }` 확인. `push.sh` 가 `~/.config/seorilabs/backoffice.env`
의 `INTERNAL_ADMIN_TOKEN` 으로 인증한다(토큰 출력 금지).

## 5. 전용 파드 준비·인증 검증

`src/lib/analytics/console-sync/`는 고정 MCP 주소와 5개 조회 도구만 호출한다. SDK는 수치 생성에
모델을 사용하지 않는다. MiniMax는 저장된 값의 기존 분석에만 사용한다. DB advisory lock을
OAuth 갱신 전에 잡고 동시 조회 최대 2, HTTP 최대 3시도를 전체 25초 예산 안에서 수행하며 SDK 도구 timeout은 30초다. 대기와 OAuth 갱신에도 같은 취소 signal을 전달한다. 429 대기 시각은 공유하고, 긴 Retry-After·시도 소진이면 후속 조회를 멈춰 부분 완료로 남긴다.
`invalid_grant`·401 재시도 실패·403이면 재인증 필요로 중단하며, refresh token 회전이면
`OAUTH_ROTATION_REQUIRES_REVIEW`로 중단한다. 토큰은 메모리에서만 갱신하고 원본 파일을 쓰지 않는다.

선행 조건은 `seorilabs-credentials` 절차에 따른 사람의 최초 OAuth 인가, catalog 등록,
백업·복원 확인, identity/scope 확인이다. 업로드 API 키를 콘솔 OAuth로 대체하지 않는다.
Claude/Codex/connector 인증 캐시를 추출하지 않는다. 비회전 여부를 확인하기 전 운영 Secret을 만들지 않는다.
회전 감지 시 공급자가 기존 refresh token을 이미 무효화했을 수 있다. 원본 파일의 바이트를
보존해도 grant가 복구되는 것은 아니다. 최초 감독 검증은 운영에 연결되지 않은 인가로 수행하고,
회전·불완전한 갱신 결과가 발생하면 같은 옛 토큰을 반복 사용하지 말고 중단해 사람의 재인증과
보존 설계를 다시 검토한다. 기존 활성 공용 identity를 앱별 키로 대체하지 않는다.

- `AIT_CONSOLE_OAUTH_FILE`: 등록된 credential JSON 파일의 절대 경로. 로컬 0600 또는 파드의 전용 그룹 0440.
- `AIT_CONSOLE_CREDENTIAL_ID`: catalog의 승인된 논리 ID와 파일 `credentialId`가 정확히 같아야 한다.
- 파일 필드: `credentialId`, `clientId`(`mcp-gateway`), `refreshToken`; 선택 `accessToken`, `expiresAt`(Unix ms).
- `DATABASE_URL`: 검증·수집 환경 DB. 검사 모드도 수집과 같은 잠금을 사용하며 지표는 쓰지 않는다.
- `AIT_CONSOLE_CONFIRMED_LAUNCHES`: 신규 리스팅 백필의 확인된 출시일을 이번 실행에만 전달하는
  `{"slug#miniAppId":"YYYY-MM-DD"}` 입력. provider 근거를 먼저 확인하고 새로운 설정 정본으로 저장하지 않는다.
  입력 없는 신규 리스팅은 추측하지 않고 부분 완료·출시일 필요로 남긴다.

등록된 credential 환경에서 실행한다. 명령·로그에 비밀값을 넣지 않는다.

```bash
node scripts-dist/console-metrics-collector.cjs verify-auth
node scripts-dist/console-metrics-collector.cjs verify-refresh
# 승인된 검사 환경에서 새 프로세스로 verify-refresh를 다시 실행해 재시작 갱신을 확인한다.
```

`authenticated`는 인증 상태다. `metricDays`, `missing`, `errors`도 확인한다. 격리 fixture의 재시작
성공은 실제 공급자·파드의 성공 근거가 아니다. 실제 토큰 만료·revoke·회전 조건은 감독하에 별도 확인한다.

## 6. 운영 적용 gate

`k8s/console-metrics-cronjob.yaml`은 `suspend: true`, 자동 재시작·Job 재시도 없음,
서비스 계정 토큰 미주입, 전용 credential read-only mount로 준비돼 있다. 기존 배포 스크립트의
적용 목록에 포함되지 않는다. image는 `render-manifest.sh`로 승인된 immutable digest를 치환한다.
Secret 이름과 논리 ID는 준비 계약이며 실제 생성 완료를 뜻하지 않는다.

운영 배포와 스케줄 활성화 승인을 별도로 받은 뒤에만 적용한다. 첫 자연 실행은 종료 코드와
`state`, `results`의 누락·오류·경고·업서트 수 및 `readback`을 확인한다. 최신 날짜만으로 완료를
판정하지 않는다. `partial`은 종료 코드 2, 인증·실행 실패는 1이다. 문제 시 suspend하고 기존
대화형 수집을 사용하며 과거 지표를 지우거나 0으로 보정하지 않는다.

## 7. 인증·요청 오류 대응

| 코드 | 대응 |
| --- | --- |
| REAUTHENTICATION_REQUIRED | 현재 실행 중단, 운영 시 스케줄 중지 후 사람의 재인증 |
| OAUTH_ROTATION_REQUIRES_REVIEW | 기존 grant가 소진됐을 수 있음. 스케줄 중지·인가 상태 확인·보존 설계 검토 |
| OAUTH_REFRESH_OUTCOME_UNKNOWN | 전송 취소/네트워크/불완전한 성공 응답의 결과 불명. 현재 연결에서 옛 refresh 재사용 금지. 운영자는 다음 실행 전 스케줄 중지·grant 상태 확인 |
| OAUTH_CLIENT_CONFIGURATION_INVALID / OAUTH_RESOURCE_CONFIGURATION_INVALID | 재로그인 반복 대신 등록 client/resource/scope 확인 |
| OAUTH_REFRESH_NOT_SUPPORTED / OAUTH_REQUEST_REJECTED | 설정·공급자 갱신 지원 확인, 반복 인가 금지 |
| OAUTH_REFRESH_UNAVAILABLE | 알려진 오류 응답. 공급자 가용성 확인 후 영향 범위 재검증 |
| RATE_LIMITED | 전체 실행 부분 완료. Retry-After가 남은 25초 예산을 넘으면 다음 조회를 보내지 않음 |
| MCP_REQUEST_TIMEOUT | fetch/대기 취소·지표 오류. 429 예산 부족은 이 코드로 바꾸지 않음 |

중단 상태는 현재 프로세스에만 적용된다. 영속 인증 상태·자동 Secret 갱신은 승인 범위 밖이며,
운영 중 인증 오류 시 운영자가 다음 일일 실행 전 CronJob을 중지해야 한다.
[2회차 뒤 사람 재검토 항목](../../docs/design/2026-10-12-console-sync-pod/review-followup.md)을 확인한다.
