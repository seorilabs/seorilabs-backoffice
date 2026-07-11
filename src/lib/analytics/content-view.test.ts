import assert from "node:assert/strict";
import test from "node:test";
import { buildContentView } from "@/lib/analytics/content-view";
import type { AppContentSpec } from "@/lib/analytics/content-spec";
import type { ContentMetricSnapshot } from "@/lib/analytics/content-source";

const SPEC: AppContentSpec = {
  slug: "demo",
  metrics: [
    { key: "hint", label: "힌트", event: "hint_used", agg: "count" },
    { key: "avg_moves", label: "평균 수순", event: "game_end", agg: "avg", param: "move_count", unit: "수" },
    { key: "avg_dur", label: "평균 시간", event: "game_end", agg: "avg", param: "duration_sec", unit: "초" },
    { key: "starts", label: "시작", event: "game_start", agg: "count" },
    { key: "completes", label: "완료", event: "game_end", agg: "count" },
  ],
  derived: [{ key: "rate", label: "완료율", num: "completes", den: "starts" }],
  distributions: [
    { key: "outcome", label: "결과", event: "game_end", param: "outcome", valueLabels: { win: "승", loss: "패" } },
  ],
  groups: [
    {
      key: "level",
      label: "레벨",
      param: "level",
      render: "funnel",
      metrics: [
        { key: "s", label: "시작", event: "level_start", agg: "count" },
        { key: "c", label: "완료", event: "level_complete", agg: "count" },
        { key: "avg", label: "평균초", event: "level_complete", agg: "avg", param: "time_sec", unit: "초" },
      ],
      derived: [{ key: "clr", label: "클리어율", num: "c", den: "s" }],
    },
  ],
};

test("buildContentView: 지표/파생/분포/그룹 포맷", () => {
  const snap: ContentMetricSnapshot = {
    metrics: {
      hint: { value: 15, users: 7 },
      avg_moves: { value: 37.5 },
      avg_dur: { value: null },
      starts: { value: 200, users: 120 },
      completes: { value: 150, users: 100 },
    },
    distributions: {
      outcome: [
        { k: "win", count: 6, users: 5 },
        { k: "loss", count: 2, users: 2 },
        { k: "draw", count: 2, users: 2 },
      ],
    },
    groups: {
      level: {
        "1": { s: { value: 100, users: 80 }, c: { value: 60, users: 55 }, avg: { value: 42.1 } },
        "2": { s: { value: 50, users: 40 }, c: { value: 20, users: 18 }, avg: { value: 55 } },
      },
    },
    totalEvents: 40,
  };
  const view = buildContentView(SPEC, snap);
  // flat 카드 + 파생(완료율=150/200*100=75%).
  assert.deepEqual(view.metrics.find((m) => m.key === "hint"), { key: "hint", label: "힌트", value: "15", users: 7 });
  assert.equal(view.metrics.find((m) => m.key === "avg_moves")!.value, "37.5수");
  assert.equal(view.metrics.find((m) => m.key === "avg_dur")!.value, "—");
  assert.equal(view.metrics.find((m) => m.key === "rate")!.value, "75%");
  // 분포 라벨/비중.
  assert.deepEqual(view.distributions[0].items.map((i) => [i.k, i.pct]), [["승", 60], ["패", 20], ["draw", 20]]);
  // 그룹: funnel, 첫 지표(s) 내림차순, reachPct(레벨2 s=50/max100=50%), 클리어율 파생.
  const g = view.groups[0];
  assert.equal(g.render, "funnel");
  assert.deepEqual(g.rows.map((r) => r.key), ["1", "2"]);
  assert.equal(g.rows[0].reachPct, 100);
  assert.equal(g.rows[1].reachPct, 50);
  assert.equal(g.rows[0].cells.avg, "42.1초");
  assert.equal(g.rows[0].cells.clr, "60%"); // 60/100
  assert.equal(view.totalEvents, 40);
});

test("buildContentView: 스냅샷에 없는 key 는 안전 기본값", () => {
  const empty: ContentMetricSnapshot = { metrics: {}, distributions: {}, groups: {}, totalEvents: 0 };
  const view = buildContentView(SPEC, empty);
  assert.deepEqual(view.distributions[0].items, []);
  assert.equal(view.metrics.find((m) => m.key === "hint")!.value, "—");
  assert.equal(view.metrics.find((m) => m.key === "rate")!.value, "—"); // den=0
  assert.deepEqual(view.groups[0].rows, []);
});

test("buildContentView: order 고정 그룹 순서", () => {
  const spec: AppContentSpec = {
    slug: "d",
    groups: [
      {
        key: "diff",
        label: "난이도",
        param: "difficulty",
        order: ["easy", "normal", "hard"],
        valueLabels: { easy: "쉬움", normal: "보통", hard: "어려움" },
        metrics: [{ key: "n", label: "수", event: "game_end", agg: "count" }],
      },
    ],
  };
  const snap: ContentMetricSnapshot = {
    metrics: {},
    distributions: {},
    groups: { diff: { hard: { n: { value: 9, users: 5 } }, easy: { n: { value: 3, users: 2 } } } },
    totalEvents: 0,
  };
  const view = buildContentView(spec, snap);
  // order 고정 → easy, hard (normal 은 데이터 없어 제외), 라벨 적용.
  assert.deepEqual(view.groups[0].rows.map((r) => [r.key, r.label]), [["easy", "쉬움"], ["hard", "어려움"]]);
});
