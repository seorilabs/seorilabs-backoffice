import assert from "node:assert/strict";
import test from "node:test";
import {
  aggConsoleWindow,
  completePeriodChangePct,
  consoleMonthWindow,
  formatConsoleWindowRow,
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

test("aggConsoleWindow: 콘솔 미집계일(dau=null)은 합 0 취급·평균 분모 제외", () => {
  const rows = [
    row("2026-07-30", { dau: 8, newUsers: 4, avgSessionSec: 79 }),
    row("2026-07-29", { dau: null, newUsers: null, avgSessionSec: 30 }), // 세션만, DAU 미집계
    row("2026-07-28", { dau: 4, newUsers: 2, avgSessionSec: 137 }),
  ];
  const a = aggConsoleWindow(rows)!;
  assert.equal(a.dauSum, 12); // 8+0+4, null→0
  assert.equal(a.dauAvg, 6); // (8+4)/2, null 일은 분모 제외
  assert.equal(a.newSum, 6); // 4+0+2
  assert.equal(a.days, 3); // 수집 일수는 그대로 3
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

const iso = (d: Date) => d.toISOString().slice(0, 10);

test("formatConsoleWindowRow: 집계 없으면(agg=null) 모든 셀이 '—'(0 아님)", () => {
  const d = formatConsoleWindowRow(null, iso);
  assert.deepEqual(d, {
    period: "—",
    dauSum: "—",
    dauAvg: "—",
    newSum: "—",
    sessAvg: "—",
    iaaImpSum: "—",
    iaaEarnKrw: "—",
  });
  // 0 으로 오도하지 않는다.
  assert.equal(Object.values(d).includes("0"), false);
});

test("formatConsoleWindowRow: 집계 있으면 기간/합/일평균/수익을 포맷한다", () => {
  const d = formatConsoleWindowRow(
    {
      days: 7,
      dateMin: new Date("2026-07-15"),
      dateMax: new Date("2026-07-21"),
      dauSum: 98,
      dauAvg: 14,
      newSum: 54,
      sessAvg: 156.4,
      iaaImpSum: 102,
      iaaEarnSum: 399.6,
    },
    iso,
  );
  assert.equal(d.period, "2026-07-15~2026-07-21");
  assert.equal(d.dauSum, "98");
  assert.equal(d.dauAvg, "14.0");
  assert.equal(d.newSum, "54");
  assert.equal(d.sessAvg, "156초");
  assert.equal(d.iaaImpSum, "102");
  assert.equal(d.iaaEarnKrw, "₩400");
});

test("formatConsoleWindowRow: 세션 평균이 null 이면 '—'", () => {
  const d = formatConsoleWindowRow(aggWith(3), iso);
  assert.equal(d.sessAvg, "—");
});

test("consoleMonthWindow: 최신 기준일로 이번 달·전월 동기간·전월 전체 경계를 계산한다", () => {
  const w = consoleMonthWindow(new Date("2026-08-09T00:00:00.000Z"));
  assert.equal(iso(w.currentStart), "2026-08-01");
  assert.equal(iso(w.currentEndExclusive), "2026-08-10");
  assert.equal(iso(w.previousStart), "2026-07-01");
  assert.equal(iso(w.previousComparableEndExclusive), "2026-07-10");
  assert.equal(iso(w.previousEndExclusive), "2026-08-01");
  assert.equal(w.currentElapsedDays, 9);
  assert.equal(w.previousComparableDays, 9);
  assert.equal(w.previousCalendarDays, 31);
});

test("consoleMonthWindow: 전월이 더 짧으면 동기간을 전월 말일로 제한한다", () => {
  const w = consoleMonthWindow(new Date("2026-03-31T00:00:00.000Z"));
  assert.equal(iso(w.previousComparableEndExclusive), "2026-03-01");
  assert.equal(w.previousComparableDays, 28);
  assert.equal(w.previousCalendarDays, 28);
});

test("completePeriodChangePct: 양쪽 기간이 완전할 때만 증감률을 반환한다", () => {
  assert.equal(
    completePeriodChangePct({
      currentValue: 150,
      previousValue: 100,
      currentObserved: 9,
      currentExpected: 9,
      previousObserved: 9,
      previousExpected: 9,
    }),
    50,
  );
  assert.equal(
    completePeriodChangePct({
      currentValue: 150,
      previousValue: 100,
      currentObserved: 8,
      currentExpected: 9,
      previousObserved: 9,
      previousExpected: 9,
    }),
    null,
  );
  assert.equal(
    completePeriodChangePct({
      currentValue: 10,
      previousValue: 0,
      currentObserved: 9,
      currentExpected: 9,
      previousObserved: 9,
      previousExpected: 9,
    }),
    null,
  );
  assert.equal(
    completePeriodChangePct({
      currentValue: 150,
      previousValue: 100,
      currentObserved: 31,
      currentExpected: 31,
      previousObserved: 28,
      previousExpected: 28,
    }),
    null,
  );
});
