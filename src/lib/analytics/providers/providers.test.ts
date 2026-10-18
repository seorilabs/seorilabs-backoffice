import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { applePages, readAppleInstance, downloadAppleSegment } from "./apple-analytics";
import { parseAdmobReport } from "./admob";
import { aggregateReportRows } from "../report-query";
import { unifiedMetricRowSchema } from "../unified-metrics";

test("Apple의 모든 페이지를 읽고 외부 next와 순환은 거절한다", async () => {
  const seen: string[] = [];
  assert.equal((await applePages("/v1/apps", async (path) => { seen.push(path); return path.includes("cursor") ? { data: [{ id: "2", type: "apps" }] } : { data: [{ id: "1", type: "apps" }], links: { next: "https://api.appstoreconnect.apple.com/v1/apps?cursor=2" } }; })).length, 2);
  assert.equal(seen.length, 2);
  await assert.rejects(applePages("/v1/apps", async () => ({ links: { next: "https://evil.example/v1/apps" } })), /PAGINATION/);
  await assert.rejects(applePages("/v1/apps", async () => ({ data: [{ id: "1", type: "apps" }, { id: "1", type: "apps" }] })), /DUPLICATE/);
});
test("Apple의 모든 segment·checksum·대상을 확인하고 중간 실패에서는 부분 값을 반환하지 않는다", async () => {
  const buffer = gzipSync(Buffer.from("Date\tApp Apple Identifier\tCounts\n2026-10-15\t123\t5\n"));
  const segment = { id: "1", type: "analyticsReportSegments", attributes: { url: "https://example.apple.com/file", sizeInBytes: buffer.length, checksum: createHash("md5").update(buffer).digest("hex") } };
  const input = { appId: "123", reportType: "App Downloads Standard", processingDate: "2026-10-18", segments: [segment] };
  assert.equal((await readAppleInstance(input, async () => buffer)).rows[0].row.value, 5);
  await assert.rejects(readAppleInstance({ ...input, segments: [segment, { ...segment, id: "2" }] }, async () => buffer), /ROW_DUPLICATE/);
  await assert.rejects(readAppleInstance({ ...input, segments: [segment, { ...segment, attributes: { ...segment.attributes, checksum: "wrong" } }] }, async () => buffer), /CHECKSUM/);
  await assert.rejects(downloadAppleSegment("http://127.0.0.1/secret"), /HOST/);
});
const admobInput = { appId: "ca-app-pub-1~2", start: "2026-10-15", end: "2026-10-15", processingDate: "2026-10-18", currency: "USD" };
const report = () => [{ header: { dateRange: { startDate: { year:2026,month:10,day:15 }, endDate: { year:2026,month:10,day:15 } }, localizationSettings: { currencyCode: "USD" } } }, { row: { dimensionValues: { APP: { value: admobInput.appId }, DATE: { value: "20261015" }, COUNTRY: { value: "US" } }, metricValues: { AD_REQUESTS: { integerValue: "100" }, MATCHED_REQUESTS: { integerValue: "80" }, IMPRESSIONS: { integerValue: "40" }, CLICKS: { integerValue: "1" }, ESTIMATED_EARNINGS: { microsValue: "6500000" } } } }, { footer: { matchingRowCount: "1" } }];
test("AdMob micro 통화와 응답률에 실제 분모를 쓰고 footer 부재는 성공으로 판단하지 않는다", () => {
  const rows = parseAdmobReport(report(), admobInput);
  assert.equal(rows.find((cell) => cell.row.metric === "ad_estimated_revenue")?.row.value, 6.5);
  assert.equal(rows.find((cell) => cell.row.metric === "match_rate")?.row.value, 80);
  assert.equal(rows.find((cell) => cell.row.metric === "show_rate")?.row.denominator, 80);
  assert.throws(() => parseAdmobReport(report().slice(0, 2), admobInput), /PARTIAL/);
  assert.throws(() => parseAdmobReport(report(), { ...admobInput, appId: "other" }), /APP_MISMATCH/);
  assert.throws(() => parseAdmobReport(report(), { ...admobInput, currency: "KRW" }), /SCOPE_MISMATCH/);
});
test("비공개 셀은 전체 합계를 숨기고 고유값은 차원 간 더하지 않는다", () => {
  const row = unifiedMetricRowSchema.parse({ metric: "store_downloads", value: 5, dimensions: {}, currency: null, state: "observed", valueStatus: "analyzable" });
  assert.equal(aggregateReportRows([row, { ...row, value: null, state: "not_landed" }]).value, null);
  assert.equal(aggregateReportRows([{ ...row, metric: "unique_devices" }, { ...row, metric: "unique_devices" }]).value, null);
});

test("AdMob no-fill 행의 분모 0은 다른 행의 표시율·eCPM을 숨기지 않는다", () => {
  const input = report();
  const noFill = structuredClone(input[1]);
  noFill.row!.dimensionValues.COUNTRY.value = "KR";
  for (const [key, value] of Object.entries(noFill.row!.metricValues)) {
    if ("microsValue" in value) value.microsValue = "0";
    else if ("integerValue" in value) value.integerValue = key === "AD_REQUESTS" ? "20" : "0";
  }
  const rows = parseAdmobReport([input[0], input[1], noFill, { footer: { matchingRowCount: "2" } }], admobInput);
  assert.equal(aggregateReportRows(rows.filter((row) => row.row.metric === "show_rate").map((row) => row.row)).value, 50);
  assert.equal(aggregateReportRows(rows.filter((row) => row.row.metric === "ad_ecpm").map((row) => row.row)).value, 162.5);
  assert.equal(aggregateReportRows(rows.filter((row) => row.row.metric === "match_rate").map((row) => row.row)).value, 100 * 80 / 120);
});
test("AdMob 최근 수익도 경과일이 부족하면 잠정으로 표시한다", () => {
  assert.equal(parseAdmobReport(report(), { ...admobInput, processingDate: "2026-10-16" }).find((cell) => cell.row.metric === "ad_estimated_revenue")!.row.valueStatus, "provisional");
});
