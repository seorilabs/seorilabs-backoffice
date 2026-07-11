import assert from "node:assert/strict";
import test from "node:test";
import { buildContentSql, mapContentRows, type ContentSqlRow } from "@/lib/ga4/content-shapes";
import type { AppContentSpec } from "@/lib/analytics/content-spec";

const SPEC: AppContentSpec = {
  slug: "demo",
  distributions: [
    { key: "outcome", label: "결과", event: "game_end", param: "outcome", topN: 2 },
  ],
  counters: [{ key: "hint", label: "힌트", event: "hint_used" }],
  measures: [{ key: "avg_moves", label: "평균 수순", event: "game_end", param: "move_count", agg: "avg" }],
};

test("buildContentSql: 단일 스캔 base + 종류별 UNION ALL + total", () => {
  const sql = buildContentSql(SPEC, "`p.d.events_*`", "20260101", "20260107");
  assert.match(sql, /WITH base AS/);
  assert.match(sql, /_TABLE_SUFFIX BETWEEN '20260101' AND '20260107'/);
  assert.match(sql, /event_name IN \('game_end', 'hint_used'\)/);
  assert.match(sql, /'dist' AS kind/);
  assert.match(sql, /'cnt' AS kind/);
  assert.match(sql, /'measure' AS kind/);
  assert.match(sql, /'total' AS kind/);
  assert.match(sql, /AVG\(/);
  // UNION ALL 파트 수 = dist1 + cnt1 + measure1 + total1 = 3 개의 UNION ALL 구분자.
  assert.equal(sql.split("UNION ALL").length - 1, 3);
});

test("buildContentSql: 잘못된 식별자는 조립 실패(SQL 주입 방어)", () => {
  const bad: AppContentSpec = {
    slug: "x",
    distributions: [{ key: "k", label: "l", event: "game_end", param: "a'; DROP", topN: 2 }],
    counters: [],
    measures: [],
  };
  assert.throws(() => buildContentSql(bad, "`p.d.events_*`", "1", "2"), /식별자 규격 위반/);
});

test("mapContentRows: 분포 정렬/topN, 카운터/수치/총계 피벗", () => {
  const rows: ContentSqlRow[] = [
    { date: "2026-01-01", kind: "dist", metric: "outcome", val: "win", a: 5, b: 4 },
    { date: "2026-01-01", kind: "dist", metric: "outcome", val: "loss", a: 9, b: 7 },
    { date: "2026-01-01", kind: "dist", metric: "outcome", val: "draw", a: 1, b: 1 },
    { date: "2026-01-01", kind: "cnt", metric: "hint", val: "", a: 12, b: 6 },
    { date: "2026-01-01", kind: "measure", metric: "avg_moves", val: "", a: 37.5, b: 0 },
    { date: "2026-01-01", kind: "total", metric: "", val: "", a: 27, b: 0 },
  ];
  const out = mapContentRows(rows, SPEC);
  const snap = out["2026-01-01"];
  // topN=2 → count 내림차순 loss(9), win(5) 만 남고 draw 탈락.
  assert.deepEqual(
    snap.distributions.outcome.map((d) => d.k),
    ["loss", "win"],
  );
  assert.equal(snap.distributions.outcome[0].count, 9);
  assert.equal(snap.distributions.outcome[0].users, 7);
  assert.deepEqual(snap.counters.hint, { count: 12, users: 6 });
  assert.equal(snap.measures.avg_moves, 37.5);
  assert.equal(snap.totalEvents, 27);
});

test("mapContentRows: 데이터 없는 날도 스펙 key 는 안정적 기본값", () => {
  const out = mapContentRows(
    [{ date: "2026-01-02", kind: "total", metric: "", val: "", a: 0, b: 0 }],
    SPEC,
  );
  const snap = out["2026-01-02"];
  assert.deepEqual(snap.distributions.outcome, []);
  assert.deepEqual(snap.counters.hint, { count: 0, users: 0 });
  assert.equal(snap.measures.avg_moves, null);
  assert.equal(snap.totalEvents, 0);
});
