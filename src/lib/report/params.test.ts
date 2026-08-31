import assert from "node:assert/strict";
import test from "node:test";
import { clampReportDate, parseReportDate, resolveReportRange, shiftDay } from "@/lib/report/params";

test("형식이 어긋나거나 실존하지 않는 날짜는 조용히 무시한다", () => {
  assert.equal(parseReportDate("2026-08-31"), "2026-08-31");
  for (const raw of [undefined, null, "", "2026-8-31", "20260831", "2026-02-30", "2026-13-01", "다음주"]) {
    assert.equal(parseReportDate(raw), null, String(raw));
  }
});

test("범위 밖 날짜는 redirect 대신 clamp 하고 조정 사실을 알린다", () => {
  const min = "2026-07-01";
  const max = "2026-08-31";
  assert.deepEqual(clampReportDate("2026-08-15", min, max), { date: "2026-08-15", clamped: false });
  assert.deepEqual(clampReportDate("2026-06-01", min, max), { date: min, clamped: true });
  assert.deepEqual(clampReportDate("2026-09-15", min, max), { date: max, clamped: true });
  assert.deepEqual(clampReportDate(min, min, max), { date: min, clamped: false });
  assert.deepEqual(clampReportDate(max, min, max), { date: max, clamped: false });
});

test("전일/익일 이동은 월·연 경계를 넘는다", () => {
  assert.equal(shiftDay("2026-08-31", 1), "2026-09-01");
  assert.equal(shiftDay("2026-09-01", -1), "2026-08-31");
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
});

// ── resolveReportRange: 날짜 피커 범위·기본 선택일 ──────────────────────────

const NOW = new Date("2026-09-01T05:00:00.000Z"); // 최신 확정일(D-1) = 2026-08-31
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

function bounds(ga4: [string, string] | null, console_: [string, string] | null) {
  return [
    { min: ga4 ? day(ga4[0]) : null, max: ga4 ? day(ga4[1]) : null },
    { min: console_ ? day(console_[0]) : null, max: console_ ? day(console_[1]) : null },
  ];
}

test("기본 선택일은 오늘이 아니라 데이터가 존재하는 최신 확정일이다", () => {
  const range = resolveReportRange({
    requested: null,
    bounds: bounds(["2026-07-01", "2026-08-31"], ["2026-07-10", "2026-08-30"]),
    now: NOW,
  });
  // 두 소스 중 늦은 max(GA4 08-31)가 기본이고, min 은 이른 쪽(GA4 07-01)이다.
  assert.deepEqual(range, { min: "2026-07-01", max: "2026-08-31", selected: "2026-08-31", clamped: false });
});

test("수집이 밀린 날에도 빈 화면 대신 데이터가 있는 최신일을 기본으로 잡는다", () => {
  // GA4 수집이 이틀 밀려 최신 데이터가 08-29 뿐인 상황.
  const range = resolveReportRange({
    requested: null,
    bounds: bounds(["2026-07-01", "2026-08-29"], null),
    now: NOW,
  });
  assert.equal(range?.selected, "2026-08-29");
  assert.equal(range?.max, "2026-08-29");
});

test("과거 날짜 요청은 범위 안이면 그대로 선택된다", () => {
  const range = resolveReportRange({
    requested: "2026-08-15",
    bounds: bounds(["2026-07-01", "2026-08-31"], null),
    now: NOW,
  });
  assert.deepEqual(range, { min: "2026-07-01", max: "2026-08-31", selected: "2026-08-15", clamped: false });
});

test("범위 밖 요청은 clamp 되고 조정 사실이 남는다", () => {
  const base = { bounds: bounds(["2026-07-01", "2026-08-31"], null), now: NOW };
  assert.deepEqual(resolveReportRange({ ...base, requested: "2026-06-01" }), {
    min: "2026-07-01",
    max: "2026-08-31",
    selected: "2026-07-01",
    clamped: true,
  });
  // 미래 날짜 요청은 최신 확정일로 내려온다.
  assert.deepEqual(resolveReportRange({ ...base, requested: "2026-09-15" }), {
    min: "2026-07-01",
    max: "2026-08-31",
    selected: "2026-08-31",
    clamped: true,
  });
});

test("피커 상한은 미래 적재가 있어도 최신 확정일(D-1)을 넘지 않는다", () => {
  const range = resolveReportRange({
    requested: null,
    bounds: bounds(["2026-07-01", "2026-09-05"], null),
    now: NOW,
  });
  assert.equal(range?.max, "2026-08-31");
  assert.equal(range?.selected, "2026-08-31");
});

test("데이터가 전혀 없으면 범위를 만들지 않는다", () => {
  assert.equal(resolveReportRange({ requested: null, bounds: bounds(null, null), now: NOW }), null);
});
