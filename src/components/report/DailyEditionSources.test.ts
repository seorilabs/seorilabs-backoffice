import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DailyEditionSources } from "./DailyEditionSections";
import type { OrgReportDocument } from "@/lib/core/org-report-schema";
import type { SourceCoverage } from "@/lib/report/daily-contract";

test("닫힌 앱 수집표는 고정된 요약만 먼저 그리고 본문 행은 펼칠 때 그린다", () => {
  const row = (slug: string, state: SourceCoverage["state"]): SourceCoverage => ({
    appId: slug, slug, appName: `${slug} 앱`, source: "ga4", reportType: state,
    account: null, credentialId: null, state, dataThrough: null,
    reason: "표를 펼쳤을 때 확인할 원천 상세", remedy: "확인할 입력",
    runId: "frozen-run", configRevision: 7,
  });
  const sources = [row("first", "observed"), row("first", "not_landed"), row("first", "not_applicable"), row("second", "empty"), row("second", "failed")];
  const doc = { edition: { sources } } as unknown as OrgReportDocument;
  const before = JSON.stringify(doc);
  const html = renderToStaticMarkup(React.createElement(DailyEditionSources, { doc }));

  assert.match(html, /first 앱/);
  assert.match(html, /second 앱/);
  assert.equal((html.match(/1\/2개 보고서 확보/g) ?? []).length, 2);
  assert.equal((html.match(/<details\b/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<table\b|<tbody\b|<tr\b/);
  assert.doesNotMatch(html, /표를 펼쳤을 때 확인할 원천 상세/);
  assert.equal(JSON.stringify(doc), before, "고정된 원천을 표시 과정에서 바꾸지 않는다");
});
