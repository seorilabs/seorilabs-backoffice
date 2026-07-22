import assert from "node:assert/strict";
import test from "node:test";
import {
  aggConsoleWindow,
  rankConsoleWindows,
  type ConsoleWindowAgg,
  type ConsoleWindowRow,
} from "@/lib/analytics/console-window";

const row = (d: string, o: Partial<ConsoleWindowRow> = {}): ConsoleWindowRow => ({
  date: new Date(d),
  dau: 0,
  newUsers: 0,
  avgSessionSec: null,
  iaaImpressions: 0,
  iaaEarningKrw: 0,
  ...o,
});

// 최신→과거 정렬(orderBy date desc)로 들어온다는 계약.
const ROWS: ConsoleWindowRow[] = [
  row("2026-07-21", { dau: 11, newUsers: 2, avgSessionSec: 72, iaaImpressions: 4, iaaEarningKrw: 38.91 }),
  row("2026-07-20", { dau: 5, newUsers: 0, avgSessionSec: 97, iaaImpressions: 1, iaaEarningKrw: 23 }),
  row("2026-07-19", { dau: 10, newUsers: 3, avgSessionSec: 125, iaaImpressions: 4, iaaEarningKrw: 74 }),
];

test("aggConsoleWindow: 빈 배열은 null", () => {
  assert.equal(aggConsoleWindow([]), null);
});

test("aggConsoleWindow: 합/일평균/기간을 집계한다", () => {
  const a = aggConsoleWindow(ROWS)!;
  assert.equal(a.days, 3);
  assert.equal(a.dauSum, 26);
  assert.equal(a.dauAvg, 26 / 3);
  assert.equal(a.newSum, 5);
  assert.equal(a.iaaImpSum, 9);
  assert.equal(a.iaaEarnSum, 135.91);
  // rows 는 최신→과거라 dateMax=첫 행, dateMin=마지막 행.
  assert.equal(a.dateMax.toISOString().slice(0, 10), "2026-07-21");
  assert.equal(a.dateMin.toISOString().slice(0, 10), "2026-07-19");
});

test("aggConsoleWindow: 세션 평균은 값 있는 날만, 일평균 DAU 는 존재 일수 기준", () => {
  const rows = [
    row("2026-07-18", { dau: 12, avgSessionSec: 100 }),
    row("2026-07-17", { dau: 8, avgSessionSec: null }), // 세션 없는 날 — 세션 평균 분모에서 제외
  ];
  const a = aggConsoleWindow(rows)!;
  assert.equal(a.sessAvg, 100); // (100)/1, null 제외
  assert.equal(a.dauAvg, 10); // (12+8)/2, DAU 는 두 날 모두 포함
});

test("aggConsoleWindow: 세션이 전부 null 이면 sessAvg 는 null", () => {
  const a = aggConsoleWindow([row("2026-07-16", { dau: 1 })])!;
  assert.equal(a.sessAvg, null);
});

const aggWith = (dauSum: number): ConsoleWindowAgg => ({
  days: 1,
  dateMin: new Date("2026-07-21"),
  dateMax: new Date("2026-07-21"),
  dauSum,
  dauAvg: dauSum,
  newSum: 0,
  sessAvg: null,
  iaaImpSum: 0,
  iaaEarnSum: 0,
});

test("rankConsoleWindows: DAU 합 내림차순, 집계 없는 앱(agg=null)은 뒤로", () => {
  const items = [
    { id: "a", agg: aggWith(10) },
    { id: "z", agg: null },
    { id: "b", agg: aggWith(98) },
    { id: "c", agg: aggWith(40) },
  ];
  const ranked = rankConsoleWindows(items);
  assert.deepEqual(
    ranked.map((r) => r.id),
    ["b", "c", "a", "z"],
  );
});

test("rankConsoleWindows: 원본 배열을 변경하지 않는다", () => {
  const items = [
    { id: "a", agg: aggWith(1) },
    { id: "b", agg: aggWith(2) },
  ];
  rankConsoleWindows(items);
  assert.deepEqual(
    items.map((r) => r.id),
    ["a", "b"],
  );
});
