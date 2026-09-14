import assert from "node:assert/strict";
import test from "node:test";
import { metricDayOf, metricDayStart } from "@/lib/analytics/metric-day";

test("야간 보고 구간은 KST 자정부터 시작한다", () => {
  // sendOperationsSummary 가 쓰는 조합. 사설 KST 구현을 지웠으므로 공용 축으로 고정한다.
  const now = new Date("2026-08-17T13:30:00Z");
  assert.equal(metricDayStart(metricDayOf(now)).toISOString(), "2026-08-16T15:00:00.000Z");
});
