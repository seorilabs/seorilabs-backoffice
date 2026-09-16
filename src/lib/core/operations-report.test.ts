import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { metricDayOf, metricDayStart } from "@/lib/analytics/metric-day";

test("야간 보고 구간은 KST 자정부터 시작한다", () => {
  // sendOperationsSummary 가 쓰는 조합. 사설 KST 구현을 지웠으므로 공용 축으로 고정한다.
  const now = new Date("2026-08-17T13:30:00Z");
  assert.equal(metricDayStart(metricDayOf(now)).toISOString(), "2026-08-16T15:00:00.000Z");
});

// 소스 계약: operational_event.appId 는 Platform registry app_id 다. slug 로만 찾으면
// 둘이 다른 앱(운글=ungeul/saju-reader)이 야간 요약에서 "**ungeul**" 처럼 원시 ID 로
// 찍힌다. 수신 라우트와 같은 조회 규칙을 쓴다는 사실을 고정한다.
test("소스 계약: 야간 요약 앱 이름은 platformAppId 를 우선해 찾는다", () => {
  const src = readFileSync("src/lib/core/operations-report.ts", "utf8");
  assert.match(src, /platformAppId: \{ in: appIds \}/);
  assert.match(src, /platformAppId: null, slug: \{ in: appIds \}/);
  assert.match(src, /app\.platformAppId \?\? app\.slug/);
});

// platform 이 발행하지 않는 이벤트 타입의 라벨은 죽은 분기다. 라벨만 남으면
// 있지도 않은 실패가 집계에 잡히는 것처럼 읽힌다.
test("소스 계약: 발행되지 않는 실패 이벤트 라벨을 들고 있지 않는다", () => {
  const src = readFileSync("src/lib/core/operations-report.ts", "utf8");
  assert.equal(/iap\.completion_failed|ad\.reward\.delivery_failed/.test(src), false);
});
