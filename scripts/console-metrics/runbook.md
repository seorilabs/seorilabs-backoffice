# 콘솔 지표 수집 런북 (온디맨드)

대화형 Claude 세션에서 이 절차를 따라 AppsInToss 콘솔 지표를 백오피스로 수집한다.
**무인 자동화가 아니다** — 콘솔 MCP 는 대화형 세션 OAuth 로만 인증되고 토큰이 짧게 만료된다
(headless/cloud routine 불가). 세션마다 토큰이 만료돼 있으면 먼저 `/mcp` 로 재인증한다.

## 0. 대상 앱

`src/lib/analytics/ait-apps.ts` 의 `AIT_WORKSPACE_ID`, `AIT_MINIAPP_BY_SLUG`(slug → miniAppId)를 정본으로.

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

## 2. 앱마다 MCP 조회 (workspaceId = AIT_WORKSPACE_ID)

- `dashboard_dau` { startDate, endDate, timeUnit:"DAY" }
  → 날짜별 `au[].value`=dau, `newAu[].value`=newUsers. referrer/age/gender/os/appVersion 은 raw.
- `dashboard_session` { startDate, endDate, timeUnit:"DAY" } → 날짜별 `metric[].value`=avgSessionSec.
- `dashboard_revenue_iaa` osType "ANDROID"·"IOS" 각각 { startDate, endDate, osType }
  → 날짜별 `dailyReports[].impression` 합=iaaImpressions, `estimatedEarning` 합=iaaEarningKrw. OS별 상세는 raw.
- `dashboard_revenue_iap` { startDate, endDate, timeUnitType:"DAY" }
  → 날짜별 `trxAmount`=iapTrxAmountKrw, `settlementAmount`=iapSettlementKrw, `pu`=payingUsers. arpu/arppu/pur 은 raw.
- (선택) `dashboard_retention` { ..., dimension:"REFERRER" } → 구간 코호트라 endDate 의 raw.retention 에만.

앱/지표별 에러·빈결과는 해당 값만 비우고 계속. **0 으로 채워 push 하지 말 것**(기존 upsert 를
0 으로 덮어쓰는 파괴적 동작 — 값이 없으면 그 필드를 생략).

## 3. 페이로드 (`ConsoleMetricsPush`, console-source.ts)

```json
{ "apps": [ { "slug": "happy-farm", "miniAppId": 31877, "workspaceId": 38345,
  "days": [ { "date": "2026-07-16", "dau": 9, "newUsers": 2, "avgSessionSec": 87.7,
              "iaaImpressions": 5, "iaaEarningKrw": 26.9,
              "iapTrxAmountKrw": 0, "iapSettlementKrw": 0, "payingUsers": 0,
              "raw": { "referrer": [], "iaaByOs": {}, "iapDetail": {}, "retention": {} } } ] } ] }
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
