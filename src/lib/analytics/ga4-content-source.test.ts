import assert from "node:assert/strict";
import test from "node:test";
import { ga4ContentSource, mapRawContentRows } from "@/lib/analytics/ga4-content-source";
import type { AppContentSpec } from "@/lib/analytics/content-spec";

const SPEC: AppContentSpec = {
  slug: "demo",
  distributions: [{ key: "outcome", label: "결과", event: "game_end", param: "outcome", topN: 2 }],
  counters: [{ key: "hint", label: "힌트", event: "hint_used" }],
  measures: [{ key: "avg_moves", label: "평균 수순", event: "game_end", param: "move_count", agg: "avg" }],
};

test("mapRawContentRows: BigQuery 래핑값/누락 컬럼 안전 변환", () => {
  const rows = mapRawContentRows([
    { date: "2026-01-01", kind: "dist", metric: "outcome", val: "win", a: { value: "6" }, b: 4 },
    { date: "2026-01-01", kind: "cnt", metric: "hint", val: null, a: "12", b: 6 },
    { date: "2026-01-01", kind: "total", metric: "", a: 20 }, // b 누락 → 0
  ]);
  assert.deepEqual(rows[0], { date: "2026-01-01", kind: "dist", metric: "outcome", val: "win", a: 6, b: 4 });
  assert.equal(rows[1].val, ""); // null val → ""
  assert.equal(rows[1].a, 12); // 문자열 숫자 → number
  assert.equal(rows[2].b, 0); // 누락 → 0
});

test("queryContentMetrics: GA4 대상 미해석이면 BigQuery 호출 전에 throw", async () => {
  await assert.rejects(
    () =>
      ga4ContentSource.queryContentMetrics(
        { slug: "demo", firebaseProject: null, dataset: null },
        SPEC,
        "20260101",
        "20260107",
      ),
    /GA4 대상 미해석/,
  );
});
