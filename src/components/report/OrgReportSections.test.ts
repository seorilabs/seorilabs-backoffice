import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SummaryCards } from "./OrgReportSections";
import type { OrgReportDocument } from "@/lib/core/org-report-schema";

function summary(ga4Apps: number, listings: number) {
  return {
    summary: {
      ga4: { apps: ga4Apps, dau: 0, newUsers: 0, dauPrev: 152 },
      console: { listings, iaaKrw: 0, iaaPrevKrw: 100, iapTrxKrw: 0, payingUsers: 0 },
    },
    retention: null,
    costs: null,
  } as unknown as OrgReportDocument;
}

test("자료가 없는 요약은 0명이나 수익 감소율을 표시하지 않는다", () => {
  const html = renderToStaticMarkup(React.createElement(SummaryCards, { doc: summary(0, 0) }));
  assert.equal((html.match(/>미수집</g) ?? []).length, 4);
  assert.doesNotMatch(html, />0명</);
  assert.doesNotMatch(html, /-100\.0%/);
});

test("실제로 관측한 0명·0원은 보존한다", () => {
  const html = renderToStaticMarkup(React.createElement(SummaryCards, { doc: summary(1, 1) }));
  assert.equal((html.match(/>0명</g) ?? []).length, 2);
  assert.match(html, /₩0/);
  assert.match(html, /-100\.0%/);
});
