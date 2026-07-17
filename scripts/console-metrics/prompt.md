# AppsInToss 콘솔 지표 수집 → 백오피스 ingest

너는 이 저장소(seorilabs-backoffice)에서 로컬로 실행되는 무인 수집 작업이다. AppsInToss 콘솔
MCP(`mcp__apps-in-toss-console__*`)로 미니앱 지표를 조회해 정규화하고, 백오피스 ingest 엔드포인트로
push 한다. 사람과 대화하지 말고 아래 절차를 그대로 수행한 뒤 한 줄 요약만 출력한다.

## 0. 대상 앱 목록

`src/lib/analytics/ait-apps.ts` 의 `AIT_WORKSPACE_ID` 와 `AIT_MINIAPP_BY_SLUG`(slug → miniAppId)를
읽어 그대로 대상으로 삼는다. 표에 있는 모든 앱을 처리한다(코드가 정본 — 여기 값을 하드코딩하지 마라).

## 1. 수집 구간

- `endDate` = 어제(로컬/KST 기준 D-1), `startDate` = endDate - 13일 (총 14일, 멱등 재집계).
- `date -v-1d +%F` (endDate), `date -v-14d +%F` (startDate) 로 계산. 모두 `yyyy-MM-dd`.

## 2. 앱마다 MCP 조회 (workspaceId = AIT_WORKSPACE_ID)

각 miniAppId 에 대해:

- `dashboard_dau`      { startDate, endDate, timeUnit: "DAY" }
  → 날짜별 `au[].value` = dau, `newAu[].value` = newUsers.
  → `referrer`(유입경로, 날짜별), `age`/`gender`/`os`/`appVersion`(구간 집계)는 raw 로 보존.
- `dashboard_session`  { startDate, endDate, timeUnit: "DAY" }
  → 날짜별 `metric[].value` = avgSessionSec.
- `dashboard_revenue_iaa` 를 osType "ANDROID" 와 "IOS" 각각 호출 { startDate, endDate, osType }
  → 날짜별 `dailyReports[].impression` 합 = iaaImpressions, `estimatedEarning` 합 = iaaEarningKrw.
  → OS별 ecpm/impressionPerUser 는 raw 로 보존.
- `dashboard_revenue_iap` { startDate, endDate, timeUnitType: "DAY" }
  → 날짜별 `metric[].trxAmount` = iapTrxAmountKrw, `settlementAmount` = iapSettlementKrw, `pu` = payingUsers.
  → arpu/arppu/pur 은 raw 로 보존.
- `dashboard_retention` { startDate, endDate, timeUnit: "DAY", dimension: "REFERRER" }
  → 구간 단위 코호트라 날짜별이 아님. **가장 마지막 날짜(endDate)의 raw.retention** 에만 담는다.

호출이 에러/빈결과면 그 지표만 비우고(0/누락) 계속 진행한다. 한 앱 실패가 다른 앱을 막지 않게 한다.

## 3. 페이로드 조립

`src/lib/analytics/console-source.ts` 의 `ConsoleMetricsPush` 형태로 만든다:

```json
{
  "apps": [
    {
      "slug": "happy-farm",
      "miniAppId": 31877,
      "workspaceId": 38345,
      "days": [
        { "date": "2026-07-16", "dau": 9, "newUsers": 2, "avgSessionSec": 87.7,
          "iaaImpressions": 5, "iaaEarningKrw": 26.9,
          "iapTrxAmountKrw": 0, "iapSettlementKrw": 0, "payingUsers": 0,
          "raw": { "referrer": [...], "iaaByOs": {...}, "iapDetail": {...},
                   "demographics": {...}, "retention": {...} } }
      ]
    }
  ]
}
```

- 승격 스칼라 필드는 위 매핑대로. 값이 없으면 0(또는 avgSessionSec 은 생략/null).
- raw 에는 승격하지 못한 부가 원본을 담는다. demographics(age/gender/os/appVersion)와 retention 은
  endDate 날짜의 raw 에만 넣어 중복을 피한다.
- 페이로드를 임시파일 `/tmp/console-metrics-payload.json` 로 저장한다.

## 4. Push

환경변수 `INTERNAL_ADMIN_TOKEN`, `BACKOFFICE_URL`(기본 https://backoffice.vzyx.xyz)을 사용한다.
토큰을 echo/print 하지 마라.

```bash
curl -sS --max-time 120 -X POST "$BACKOFFICE_URL/api/admin/analytics/console-collect" \
  -H "x-admin-token: $INTERNAL_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  --data-binary @/tmp/console-metrics-payload.json
```

응답 JSON(`{ ok, targetApps, upserts, skipped, errors }`)을 확인한다.

## 5. 출력

마지막에 한 줄로 요약: `console-metrics: targetApps=N upserts=M skipped=[...] errors=[...]`.
errors/skipped 가 있으면 그 내용을 함께 남긴다. 그 외 장황한 설명은 하지 않는다.
