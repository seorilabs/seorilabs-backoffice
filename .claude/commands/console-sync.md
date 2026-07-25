---
description: AppsInToss 콘솔 지표를 backoffice DB로 온디맨드 동기화(마지막 동기화 기준 증분)
---

AppsInToss 콘솔의 미니앱 지표를 backoffice DB(`app_console_metric_daily`)로 동기화한다.
콘솔 MCP 는 대화형 세션 OAuth 로만 인증되므로 이 커맨드는 **대화형 Claude 세션에서만** 동작한다.
정본 절차: `scripts/console-metrics/runbook.md`, 앱 매핑: `src/lib/analytics/ait-apps.ts`.

이 저장소 루트(`seorilabs-backoffice`)에서 실행한다(스크립트 경로가 상대경로). 다음을 순서대로 수행:

## 0. MCP 인증 확인
`apps-in-toss-console` MCP 도구가 응답하는지 확인(예: `workspace_list`). `Needs authentication`/토큰
만료면 **멈추고** 사용자에게 `/mcp` 로 `apps-in-toss-console` 재인증을 요청한다(headless 불가).

## 1. 마지막 동기화 상태 → 증분 윈도우
```bash
bash scripts/console-metrics/status.sh
```
응답(`apps[].lastDate/rows`, `minLastDate`, `appsWithNoData`)으로 윈도우를 정한다:
- `endDate` = 어제(D-1, KST).
- `startDate` = `minLastDate` − 2일(재집계 overlap). `minLastDate` 가 null(데이터 없음)이면 `endDate` − 13일.
- `appsWithNoData`(rows=0, 신규 앱)는 그 앱만 출시일 부근부터 백필(다른 앱과 startDate 달라도 됨).
- 한 앱 당 최대 120일(`MAX_DAYS_PER_APP`). 더 큰 gap 은 120일씩 나눠 반복 push.

## 2. 앱별 콘솔 MCP 조회 (workspaceId=38345)
대상 10개 앱 (slug → miniAppId). 콘솔 appName 과 backoffice slug 가 다른 경우 주의:

| slug (payload 키) | miniAppId | 콘솔 appName |
|---|---|---|
| happy-farm | 31877 | happy-farm |
| match-picture-app | 32325 | match-picture-app |
| lucid-chess | 34107 | lucid-chess |
| dpti-app | 34639 | dpti-app |
| periodic-table-app | 36076 | periodic-table |
| crossword-puzzle | 36555 | crossword-puzzle |
| vocab-swipe | 36976 | vocab-swipe |
| lucid-reversi | 44056 | lucid-reversi |
| foam-party | 50736 | foam-party |
| trait-test-hub | 54985 | trait-test-hub |

각 앱마다(구간 = 위 startDate~endDate) 호출 → 날짜별로 정규화:
- `dashboard_dau` `{startDate,endDate,timeUnit:"DAY"}` → `au[].value`=**dau**, `newAu[].value`=**newUsers**. referrer/age/gender/os/appVersion 은 `raw` 로.
- `dashboard_session` `{startDate,endDate,timeUnit:"DAY"}` → `metric[].value`=**avgSessionSec**.
- `dashboard_revenue_iaa` `osType:"ANDROID"` 와 `"IOS"` 각각 `{startDate,endDate,osType}` → 날짜별 `dailyReports[].impression` 합=**iaaImpressions**, `estimatedEarning` 합=**iaaEarningKrw**. OS별 상세는 `raw.iaaByOs`.
- `dashboard_revenue_iap` `{startDate,endDate,timeUnitType:"DAY"}` → 날짜별 `trxAmount`=**iapTrxAmountKrw**, `settlementAmount`=**iapSettlementKrw**, `pu`=**payingUsers**. arpu/arppu/pur 은 `raw.iapDetail`.
- (선택) `dashboard_retention` `{...,dimension:"REFERRER"}` → 구간 코호트라 endDate 의 `raw.retention` 에만.

**중요**: 앱/지표별 에러·빈결과는 해당 값만 비우고 계속. **0 으로 채워 push 하지 말 것**(기존
upsert 를 0 으로 덮어쓰는 파괴적 동작 — 값이 없으면 그 필드를 생략). MCP 실제 응답 형태가 위와
다르면 runbook 의 매핑을 기준으로 하되 응답을 직접 확인해 필드를 맞춘다.

## 3. 페이로드 작성 (`ConsoleMetricsPush`)
`src/lib/analytics/console-source.ts` 계약. `/tmp/console-metrics-payload.json` 에 저장:
```json
{ "apps": [ { "slug": "happy-farm", "miniAppId": 31877, "workspaceId": 38345,
  "days": [ { "date": "2026-07-16", "dau": 9, "newUsers": 2, "avgSessionSec": 87.7,
              "iaaImpressions": 5, "iaaEarningKrw": 26.9,
              "raw": { "referrer": [], "iaaByOs": {}, "iapDetail": {}, "retention": {} } } ] } ] }
```

## 4. Push
```bash
bash scripts/console-metrics/push.sh /tmp/console-metrics-payload.json
```
응답 `{ ok, targetApps, upserts, skipped, errors }` 확인. `skipped`/`errors` 가 있으면 원인 보고.

## 5. 검증·보고
- push 후 `bash scripts/console-metrics/status.sh` 재실행해 `maxLastDate` 가 endDate 로 전진했는지 확인.
- 사용자에게: 대상 앱 수, 업서트 row 수, 커버한 날짜 구간(min~max), skip/error 요약을 보고.
