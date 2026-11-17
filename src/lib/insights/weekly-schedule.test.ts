import assert from "node:assert/strict";
import test from "node:test";
import { staleWeeklySignal } from "./service";

test("주간 점검은 끝난 마지막 주의 신호만 보내고 지난 주·다른 기준일 신호는 보내지 않는다", () => {
  const now = new Date("2026-11-18T02:00:00Z"); // 수 11:00 KST, 끝난 마지막 주 11/09~11/15
  assert.equal(staleWeeklySignal({ kind: "metric-weekly", dedupeKey: "weekly:2026-11-15" }, now), false);
  assert.equal(staleWeeklySignal({ kind: "metric-weekly", dedupeKey: "weekly:2026-11-08" }, now), true);
  assert.equal(staleWeeklySignal({ kind: "metric-weekly", dedupeKey: "weekly:2026-11-16" }, now), true);
  assert.equal(staleWeeklySignal({ kind: "metric-collection", dedupeKey: "metric-collection:run" }, now), false);
});
