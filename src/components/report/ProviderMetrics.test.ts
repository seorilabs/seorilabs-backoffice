import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderMetrics } from "./ProviderMetrics";
import type { ProviderSeries } from "@/lib/analytics/report-query";
test("SVG 접근성 제목은 서버에서 하나의 텍스트로 렌더링한다", () => {
  const series: ProviderSeries = { appId: "qa", appName: "QA", source: "apple-analytics", account: "account", resource: "app", reportType: "App Downloads Standard", timeZone: "UTC", metric: "store_downloads", currency: null, segment: "", assessmentDay: "2026-10-17", unit: "건", definition: "다운로드", weekdayBaseline: null, weekdayObservations: 0, verdict: "insufficient", dimensions: [], points: [{ day: "2026-10-17", value: 5, numerator: null, denominator: null, state: "observed", valueStatus: "analyzable", sourceHash: "a".repeat(64), sourceUri: "https://api.appstoreconnect.apple.com/v1/analyticsReportInstances/qa", runId: "qa", configRevisionId: "qa" }] };
  const html = renderToStaticMarkup(React.createElement(ProviderMetrics, { series: [series] }));
  assert.ok(html.includes("<title>2026-10-17: 5 건</title>"), "title은 여러 children/comment로 나뉘면 hydration이 달라집니다.");
});
