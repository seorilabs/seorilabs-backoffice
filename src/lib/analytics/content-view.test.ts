import assert from "node:assert/strict";
import test from "node:test";
import { buildContentView } from "@/lib/analytics/content-view";
import type { AppContentSpec } from "@/lib/analytics/content-spec";
import type { ContentMetricSnapshot } from "@/lib/analytics/content-source";

const SPEC: AppContentSpec = {
  slug: "demo",
  distributions: [
    {
      key: "outcome",
      label: "결과",
      event: "game_end",
      param: "outcome",
      valueLabels: { win: "승", loss: "패" },
    },
  ],
  counters: [{ key: "hint", label: "힌트", event: "hint_used" }],
  measures: [
    { key: "avg_moves", label: "평균 수순", event: "game_end", param: "move_count", agg: "avg", unit: "수" },
    { key: "avg_dur", label: "평균 시간", event: "game_end", param: "duration_sec", agg: "avg", unit: "초" },
  ],
};

test("buildContentView: 분포 라벨/비중, 카운터/수치 포맷", () => {
  const snap: ContentMetricSnapshot = {
    distributions: {
      outcome: [
        { k: "win", count: 6, users: 5 },
        { k: "loss", count: 2, users: 2 },
        { k: "draw", count: 2, users: 2 },
      ],
    },
    counters: { hint: { count: 15, users: 7 } },
    measures: { avg_moves: 37.5, avg_dur: null },
    totalEvents: 40,
  };
  const view = buildContentView(SPEC, snap);
  const outcome = view.distributions[0];
  assert.equal(outcome.total, 10);
  // valueLabels 적용 + 비중 계산.
  assert.deepEqual(
    outcome.items.map((i) => [i.k, i.pct]),
    [["승", 60], ["패", 20], ["draw", 20]],
  );
  assert.deepEqual(view.counters[0], { key: "hint", label: "힌트", count: 15, users: 7 });
  // 단위 포함 포맷 + null 은 "—".
  assert.equal(view.measures[0].value, "37.5수");
  assert.equal(view.measures[1].value, "—");
  assert.equal(view.totalEvents, 40);
});

test("buildContentView: 스냅샷에 없는 key 는 안전 기본값", () => {
  const empty: ContentMetricSnapshot = {
    distributions: {},
    counters: {},
    measures: {},
    totalEvents: 0,
  };
  const view = buildContentView(SPEC, empty);
  assert.deepEqual(view.distributions[0].items, []);
  assert.equal(view.distributions[0].total, 0);
  assert.deepEqual(view.counters[0], { key: "hint", label: "힌트", count: 0, users: 0 });
  assert.equal(view.measures[0].value, "—");
});
