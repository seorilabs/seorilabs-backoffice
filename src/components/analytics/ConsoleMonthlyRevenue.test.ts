import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleMonthlyRevenue, type ConsoleMonthlyRevenueReport } from "./ConsoleMonthlyRevenue";

function report(observedDays: number, previousObservedDays = observedDays): ConsoleMonthlyRevenueReport {
  const current = { observedDays, impressions: 0, earningKrw: 0 };
  const previous = { observedDays: previousObservedDays, impressions: 0, earningKrw: 0 };
  return {
    reportDate: new Date("2026-10-12T00:00:00Z"), currentLabel: "2026년 10월", previousLabel: "2026년 9월",
    currentElapsedDays: 12, previousComparableDays: 12, previousCalendarDays: 30, targetListings: 1,
    currentTotal: current, previousComparableTotal: previous, previousFullTotal: previous, changePct: null,
    items: [{ key: "qa#1", appName: "QA 미수집", listingLabel: "QA", miniAppId: 1, current,
      previousComparable: previous, previousFull: previous, changePct: null }],
  };
}

test("관측이 없는 월 수익 요약·노출·각 기간은 0으로 표시하지 않는다", () => {
  const html = renderToStaticMarkup(React.createElement(ConsoleMonthlyRevenue, { report: report(0) }));
  assert.equal((html.match(/>미수집</g) ?? []).length, 6);
  assert.doesNotMatch(html, /₩0/);
  assert.doesNotMatch(html, />0<\/td>/);
  assert.match(html, /0\/12일/);
});

test("관측한 0원·0노출은 그대로 표시한다", () => {
  const html = renderToStaticMarkup(React.createElement(ConsoleMonthlyRevenue, { report: report(1) }));
  assert.doesNotMatch(html, />미수집</);
  assert.equal((html.match(/₩0/g) ?? []).length, 5);
  assert.match(html, />0<\/td>/);
});

test("현재와 과거의 관측 여부를 각 기간별로 구분한다", () => {
  const html = renderToStaticMarkup(React.createElement(ConsoleMonthlyRevenue, { report: report(1, 0) }));
  assert.equal((html.match(/>미수집</g) ?? []).length, 3);
  assert.equal((html.match(/₩0/g) ?? []).length, 2);
});
