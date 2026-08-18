import assert from "node:assert/strict";
import test from "node:test";
import { detectMetricAnomalies, type AnomalyMetricRow } from "@/lib/analytics/anomalies";

function rows(latest: Partial<AnomalyMetricRow> = {}, baselineDau = 100): AnomalyMetricRow[] {
  return Array.from({ length: 8 }, (_, index) => ({
    date: new Date(`2026-08-${String(17 - index).padStart(2, "0")}T00:00:00.000Z`),
    dau: index === 0 ? baselineDau : baselineDau,
    adCompletions: 3,
    networkAdImpressions: 3,
    ...(index === 0 ? latest : {}),
  }));
}

test("7일 중앙값 대비 60% 이상 DAU 급락만 장애로 판정한다", () => {
  assert.deepEqual(detectMetricAnomalies("게임", rows({ dau: 40 }))[0]?.kind, "dau_drop");
  assert.equal(detectMetricAnomalies("게임", rows({ dau: 41 })).length, 0);
  assert.equal(detectMetricAnomalies("게임", rows({ dau: 2 }, 10)).length, 0);
});

test("광고 완료가 충분한데 네트워크 노출이 0이면 계측 장애 후보로 판정한다", () => {
  const found = detectMetricAnomalies("게임", rows({ adCompletions: 20, networkAdImpressions: 0 }));
  assert.equal(found.some((item) => item.kind === "ad_delivery_gap"), true);
  assert.equal(detectMetricAnomalies("게임", rows({ adCompletions: 19, networkAdImpressions: 0 })).length, 0);
});
