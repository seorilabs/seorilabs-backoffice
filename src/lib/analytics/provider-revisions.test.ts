import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizedRowsHash } from "./report-batches";
import { semanticDimensions, aggregateReportRows, assessProviderSeries, providerSeriesSchema } from "./report-query";
import { unifiedMetricRowSchema } from "./unified-metrics";
import { assertPlayReportMetadata } from "./providers/play-reports";
import { readAdmob } from "./providers/admob";
const row = unifiedMetricRowSchema.parse({ metric: "subscriptions", value: 5, dimensions: { "State Metric": "Active" }, currency: null, state: "observed", valueStatus: "analyzable" });
test("같은 날짜 값은 처리일·파일 재생성·원천 행 순서와 관계없이 같은 지문이다", () => {
  const other = { ...row, value: 2, dimensions: { "State Metric": "Trial" } };
  assert.equal(normalizedRowsHash([row, other]), normalizedRowsHash([other, row]));
  assert.notEqual(normalizedRowsHash([row]), normalizedRowsHash([{ ...row, value: 6 }]));
});
test("Apple 구독 상태·이벤트와 다운로드 종류를 서로 다른 시계열로 분리한다", () => {
  assert.notEqual(semanticDimensions(row), semanticDimensions({ ...row, dimensions: { "State Metric": "Trial" } }));
  assert.notEqual(semanticDimensions({ ...row, metric: "store_downloads", dimensions: { "Download Type": "Update" } }), semanticDimensions({ ...row, metric: "store_downloads", dimensions: { "Download Type": "First-time" } }));
  for (const metric of ["device_installs", "device_uninstalls"] as const) assert.notEqual(semanticDimensions({ ...row, metric, dimensions: { "Download Type": "Update" } }), semanticDimensions({ ...row, metric, dimensions: { "Download Type": "First-time" } }));
});
test("분모0 행의 확인된 분자를 버리지 않고 전체 분자·분모로 계산한다", () => {
  const first = unifiedMetricRowSchema.parse({ ...row, metric: "show_rate", value: 50, numerator: 5, denominator: 10 });
  const boundary = unifiedMetricRowSchema.parse({ ...first, value: null, numerator: 1, denominator: 0, state: "not_applicable" });
  assert.equal(aggregateReportRows([first, boundary]).value, 60);
});
test("최신 잠정값은 유지하고 마지막 분석 가능 날짜로 판정한다", () => {
  const series = providerSeriesSchema.parse({ appId: "app", appName: "앱", source: "admob", account: "pub-1", resource: "ca-app-pub-1~2", reportType: "network", timeZone: "America/Los_Angeles", metric: "ad_requests", currency: null, unit: "건", definition: "요청", dimensions: [], verdict: "insufficient", points: [10, 10, 10, 10, 30, 999].map((value, index) => ({ day: `2026-10-${String(10 + index).padStart(2, "0")}`, value, numerator: null, denominator: null, state: "observed", valueStatus: index === 5 ? "provisional" : "analyzable", sourceHash: "hash", sourceUri: "https://admob.googleapis.com/v1/accounts/pub-1/networkReport", runId: "run", configRevisionId: "config" })) });
  const assessed = assessProviderSeries(series);
  assert.equal(assessed.assessmentDay, "2026-10-14"); assert.equal(assessed.verdict, "highlight");
  assert.equal(assessed.points.at(-1)?.value, 999);
});
test("AdMob 다른 스토어 앱으로 연결된 리소스는 보고서를 요청하기 전에 차단한다", async () => {
  const calls: string[] = [];
  await assert.rejects(readAdmob({ accountId: "pub-1", appId: "ca-app-pub-1~2", applicationId: "com.example.correct", timeZone: "America/Los_Angeles", start: "2026-10-15", end: "2026-10-16", processingDate: "2026-10-18" }, async (path) => {
    calls.push(path); return path.includes("/apps") ? { apps: [{ appId: "ca-app-pub-1~2", platform: "ANDROID", linkedAppInfo: { appStoreId: "com.example.other" } }] } : { publisherId: "pub-1", reportingTimeZone: "America/Los_Angeles", currencyCode: "USD" };
  }), /APP_IDENTITY_MISMATCH/);
  assert.ok(!calls.some((path) => path.includes("networkReport")));
});


test("수동 Play 원본의 generation·크기·CRC32C를 공식 메타데이터에 대조한다", () => {
  const bytes = Buffer.from("123456789"), metadata = { generation: "123", size: "9", crc32c: "4waSgw==" };
  assert.doesNotThrow(() => assertPlayReportMetadata(metadata, "123", bytes));
  assert.throws(() => assertPlayReportMetadata(metadata, "999999999999999999999999999999", bytes), /OFFICIAL_PROOF_MISMATCH/);
  assert.throws(() => assertPlayReportMetadata(metadata, "123", Buffer.from("123456788")), /OFFICIAL_PROOF_MISMATCH/);
  assert.throws(() => assertPlayReportMetadata({ ...metadata, size: "10" }, "123", bytes), /OFFICIAL_PROOF_MISMATCH/);
});
