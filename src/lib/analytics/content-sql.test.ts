import assert from "node:assert/strict";
import test from "node:test";
import { buildContentSql, mapContentRows, type ContentSqlRow } from "@/lib/analytics/content-sql";
import type { AppContentSpec } from "@/lib/analytics/content-spec";
import { MARKET_ALL } from "@/lib/analytics/content-source";

const SPEC: AppContentSpec = {
  slug: "demo",
  metrics: [
    { key: "hint", label: "힌트", event: "hint_used", agg: "count" },
    { key: "avg_moves", label: "평균 수순", event: "game_end", agg: "avg", param: "move_count" },
    { key: "no_hint", label: "노힌트", event: "game_end", agg: "count", where: [{ param: "no_hint", op: "eq", value: 1 }] },
  ],
  distributions: [{ key: "outcome", label: "결과", event: "game_end", param: "outcome", topN: 2 }],
  groups: [
    {
      key: "level",
      label: "레벨",
      param: "level",
      metrics: [
        { key: "starts", label: "시작", event: "level_start", agg: "count" },
        { key: "avg_sec", label: "평균초", event: "level_complete", agg: "avg", param: "time_sec" },
      ],
    },
  ],
};

test("buildContentSql: base 단일 스캔 + 종류별 UNION ALL + total", () => {
  const sql = buildContentSql(SPEC, "`p.d.events_*`", "20260101", "20260107");
  assert.match(sql, /WITH base AS/);
  assert.match(sql, /_TABLE_SUFFIX BETWEEN '20260101' AND '20260107'/);
  assert.match(sql, /event_name IN \('hint_used', 'game_end', 'level_start', 'level_complete'\)/);
  assert.match(sql, /'metric' AS kind/);
  assert.match(sql, /'dist' AS kind/);
  assert.match(sql, /'group' AS kind/);
  assert.match(sql, /'total' AS kind/);
  assert.match(sql, /AVG\(nval\)/);
  assert.match(sql, /'level\|starts' AS metric/);
  // where 필터가 조건절로 반영(no_hint=1).
  assert.match(sql, /= 1/);
  // 마켓 미선언 → 'all' 리터럴, GROUPING SETS 없음.
  assert.match(sql, /'all' AS market/);
  assert.doesNotMatch(sql, /GROUPING SETS/);
});

test("buildContentSql: truthy predicate 는 string 'true'/'1' 과 int 1 을 모두 인정", () => {
  const spec: AppContentSpec = {
    slug: "b",
    metrics: [{ key: "noHint", label: "노힌트", event: "done", agg: "count", where: [{ param: "no_hint", op: "truthy" }] }],
  };
  const sql = buildContentSql(spec, "`p.d.events_*`", "1", "2");
  assert.match(sql, /LOWER\(ep\.value\.string_value\) IN \('true', '1'\)/);
  assert.match(sql, /ep\.value\.int_value = 1/);
});

test("buildContentSql: 마켓 스펙은 market 컬럼 + GROUPING SETS", () => {
  const spec: AppContentSpec = {
    slug: "m",
    market: { param: "market", platformMap: { android: "google-play", ios: "app-store" }, values: [{ key: "google-play", label: "GP" }] },
    metrics: [{ key: "starts", label: "시작", event: "game_start", agg: "count" }],
  };
  const sql = buildContentSql(spec, "`p.d.events_*`", "1", "2");
  assert.match(sql, /AS market/);
  assert.match(sql, /GROUPING SETS \(\(date, market\), \(date\)\)/);
  assert.match(sql, /WHEN 'ANDROID' THEN 'google-play'/);
  assert.match(sql, /IFNULL\(market, 'all'\)/);
});

test("buildContentSql: 잘못된 식별자/값은 조립 실패(SQL 주입 방어)", () => {
  const bad: AppContentSpec = {
    slug: "x",
    distributions: [{ key: "k", label: "l", event: "game_end", param: "a'; DROP" }],
  };
  assert.throws(() => buildContentSql(bad, "`p.d.events_*`", "1", "2"), /식별자 규격 위반/);
  const badVal: AppContentSpec = {
    slug: "x",
    metrics: [{ key: "k", label: "l", event: "e", agg: "count", where: [{ param: "p", op: "eq", value: "a'; DROP" }] }],
  };
  assert.throws(() => buildContentSql(badVal, "`p.d.events_*`", "1", "2"), /값 규격 위반/);
});

test("mapContentRows: flat 지표/분포/그룹/총계 피벗", () => {
  const rows: ContentSqlRow[] = [
    { date: "2026-01-01", market: "all", kind: "dist", metric: "outcome", val: "win", a: 5, b: 4 },
    { date: "2026-01-01", market: "all", kind: "dist", metric: "outcome", val: "loss", a: 9, b: 7 },
    { date: "2026-01-01", market: "all", kind: "dist", metric: "outcome", val: "draw", a: 1, b: 1 },
    { date: "2026-01-01", market: "all", kind: "metric", metric: "hint", val: "", a: 12, b: 6 },
    { date: "2026-01-01", market: "all", kind: "metric", metric: "avg_moves", val: "", a: 37.5, b: 0 },
    { date: "2026-01-01", market: "all", kind: "group", metric: "level|starts", val: "1", a: 20, b: 15 },
    { date: "2026-01-01", market: "all", kind: "group", metric: "level|avg_sec", val: "1", a: 42.1, b: 0 },
    { date: "2026-01-01", market: "all", kind: "total", metric: "", val: "", a: 27, b: 0 },
  ];
  const out = mapContentRows(rows, SPEC);
  const snap = out[MARKET_ALL]["2026-01-01"];
  // topN=2 → loss(9), win(5), draw 탈락.
  assert.deepEqual(snap.distributions.outcome.map((d) => d.k), ["loss", "win"]);
  assert.deepEqual(snap.metrics.hint, { value: 12, users: 6 });
  assert.deepEqual(snap.metrics.avg_moves, { value: 37.5 });
  // 데이터 없는 flat 지표는 기본값(count=0/users=0).
  assert.deepEqual(snap.metrics.no_hint, { value: 0, users: 0 });
  assert.deepEqual(snap.groups.level["1"].starts, { value: 20, users: 15 });
  assert.deepEqual(snap.groups.level["1"].avg_sec, { value: 42.1 });
  assert.equal(snap.totalEvents, 27);
});

test("mapContentRows: 마켓별 + 통합 행 분리", () => {
  const rows: ContentSqlRow[] = [
    { date: "2026-01-01", market: "google-play", kind: "metric", metric: "hint", val: "", a: 3, b: 3 },
    { date: "2026-01-01", market: "all", kind: "metric", metric: "hint", val: "", a: 5, b: 4 },
  ];
  const out = mapContentRows(rows, SPEC);
  assert.equal(out["google-play"]["2026-01-01"].metrics.hint.value, 3);
  assert.equal(out[MARKET_ALL]["2026-01-01"].metrics.hint.value, 5);
});
