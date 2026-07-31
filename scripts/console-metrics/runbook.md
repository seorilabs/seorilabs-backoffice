# 콘솔 지표 수집 런북 (온디맨드)

대화형 Claude 세션에서 이 절차를 따라 AppsInToss 콘솔 지표를 백오피스로 수집한다.
**무인 자동화가 아니다** — 콘솔 MCP 는 대화형 세션 OAuth 로만 인증되고 토큰이 짧게 만료된다
(headless/cloud routine 불가). 세션마다 토큰이 만료돼 있으면 먼저 `/mcp` 로 재인증한다.

## 0. 대상 리스팅

`src/lib/analytics/ait-apps.ts` 의 `AIT_WORKSPACE_ID`, `AIT_LISTINGS`(리스팅 목록)를 정본으로.
수집 단위는 **App 이 아니라 콘솔 리스팅(App × miniAppId)** 이다. 한 App(=repo)이 콘솔에 여러
미니앱으로 등록될 수 있다 — 예: `crossword-puzzle` 는 웹(36555)과 네이티브 게임(56407) 둘. 이런
App 은 같은 `slug` + 다른 `miniAppId` 로 **리스팅마다 별도로 조회·push** 한다. 저장 키는
(appId, miniAppId, date) 이므로 `miniAppId` 는 페이로드에서 **필수**다.

## 1. 수집 구간 (마지막 동기화 기준 증분)

콘솔 수집은 cron 이 아니라 온디맨드라 마지막 동기화가 오래됐을 수 있다. 먼저 DB 의 마지막
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

앱/지표별 에러·빈결과는 해당 값만 비우고 계속. **0 으로 채워 push 하지 말 것**(기존 upsert 를
0 으로 덮어쓰는 파괴적 동작 — 값이 없으면 그 필드를 생략).

## 3. 페이로드 (`ConsoleMetricsPush`, console-source.ts)

`apps[]` 의 각 항목은 **리스팅 1개**(slug + miniAppId)다. 다중 리스팅 App(crossword-puzzle)은
같은 slug + 다른 miniAppId 로 **두 항목**을 넣는다. `miniAppId` 는 필수. DAU 미집계일은 `dau`/
`newUsers` 를 `null`(또는 생략)로.

```json
{ "apps": [
  { "slug": "happy-farm", "miniAppId": 31877, "workspaceId": 38345,
    "days": [ { "date": "2026-07-16", "dau": 9, "newUsers": 2, "avgSessionSec": 87.7,
                "iaaImpressions": 5, "iaaEarningKrw": 26.9,
                "raw": { "referrer": [], "iaaByOs": {} } },
              { "date": "2026-07-17", "dau": null, "newUsers": null, "avgSessionSec": 30.5,
                "iaaImpressions": 0, "iaaEarningKrw": 0 } ] },
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

## 진짜 무인화 경로

토스가 서버-투-서버 리포팅 자격증명을 제공하면 `ConsoleMetricsSource`(console-source.ts) 의 HTTP
pull 구현을 붙여 backoffice pod 가 직접 수집하도록 무중단 교체한다(스키마·ingest 규약 불변).
