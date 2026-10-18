import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVitalsRows, readVitals } from "./android-vitals";
import { aggregateReportRows } from "../report-query";
const raw = { aggregationPeriod: "DAILY", startTime: { year: 2026, month: 10, day: 15, timeZone: { id: "America/Los_Angeles" } }, metrics: [{ metric: "crashRate", decimalValue: { value: "2.5" } }, { metric: "distinctUsers", decimalValue: { value: "100" } }] };
test("공급자 품질 비율과 반올림 표본을 저장하고 정확한 분모를 만들거나 합산하지 않는다", () => {
  const rows = parseVitalsRows([raw], "2026-10-01", "2026-10-16");
  assert.equal(rows[0].row.value, 2.5); assert.equal(rows[0].row.denominator, null); assert.equal(rows[1].row.value, 100);
  assert.equal(aggregateReportRows([rows[0].row, { ...rows[0].row, dimensions: { countryCode: "US" } }]).value, null);
  assert.throws(() => parseVitalsRows([raw], "2026-10-01", "2026-10-15"), /DATE_MISMATCH/);
  assert.throws(() => parseVitalsRows([raw, raw], "2026-10-01", "2026-10-16"), /DUPLICATE/);
});
test("앱 identity·전체 페이지·공급자 최신 종료일을 확인하고 빈 응답은 행을 만들지 않는다", async () => {
  const queries: unknown[] = [];
  const reports = await readVitals({ packageName: "com.example.app", start: "2026-07-20", end: "2026-10-17" }, async (path, body) => {
    if (path.startsWith("/apps:search")) return { apps: [{ name: "apps/com.example.app", packageName: "com.example.app" }] };
    if (!body) return { name: path.slice(1), freshnessInfo: { freshnesses: [{ aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 10, day: 16 } }] } };
    queries.push(body); return {};
  });
  assert.equal(reports.length, 2); assert.ok(reports.every((one) => one.rows.length === 0 && one.periodEnd === "2026-10-15"));
  assert.ok(queries.every((body) => JSON.stringify(body).includes('"day":16')));
  await assert.rejects(readVitals({ packageName: "com.wrong.app", start: "2026-07-20", end: "2026-10-17" }, async () => ({ apps: [] })), /IDENTITY_MISSING/);
});
