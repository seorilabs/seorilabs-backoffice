import assert from "node:assert/strict";
import test from "node:test";
import { buildAppReportMd, summaryLine, type MetricRow } from "@/lib/core/analytics-report";

function row(date: string, over: Partial<MetricRow> = {}): MetricRow {
  return {
    date: new Date(`${date}T00:00:00.000Z`),
    dau: 100,
    newUsers: 10,
    d1Pct: 40,
    d3Pct: 20,
    d7Pct: 10,
    engagedUsers: 50,
    avgEngageSec: 120,
    adEventUsers: 20,
    adImpressions: 45,
    ...over,
  };
}

test("buildAppReportMd: 제목/기준일/추이표 포함, null 은 대시(—)", () => {
  const md = buildAppReportMd(
    "Happy Farm",
    [row("2026-07-04", { d7Pct: null, avgEngageSec: null }), row("2026-07-03")],
    "2026-07-05",
  );
  assert.match(md, /# Happy Farm 지표/);
  assert.match(md, /기준일 2026-07-04/);
  assert.match(md, /· D7 —/); // null → —
  assert.match(md, /평균 —초/);
  assert.match(md, /\| 2026-07-04 \|/); // 추이 표 행
  assert.match(md, /최근 2일 추이/);
});

test("summaryLine: 앱명 볼드 + 핵심 수치, null D7 은 대시", () => {
  const s = summaryLine("Lucid Chess", row("2026-07-04", { dau: 77, d7Pct: null }));
  assert.match(s, /<b>Lucid Chess<\/b>/);
  assert.match(s, /DAU 77/);
  assert.match(s, /D7 —/);
});
