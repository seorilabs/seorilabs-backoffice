import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizedRowsHash } from "./report-batches";
import { semanticDimensions } from "./report-query";
import { unifiedMetricRowSchema } from "./unified-metrics";
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
});
test("AdMob 다른 스토어 앱으로 연결된 리소스는 보고서를 요청하기 전에 차단한다", async () => {
  const calls: string[] = [];
  await assert.rejects(readAdmob({ accountId: "pub-1", appId: "ca-app-pub-1~2", applicationId: "com.example.correct", timeZone: "America/Los_Angeles", start: "2026-10-15", end: "2026-10-16", processingDate: "2026-10-18" }, async (path) => {
    calls.push(path); return path.includes("/apps") ? { apps: [{ appId: "ca-app-pub-1~2", platform: "ANDROID", linkedAppInfo: { appStoreId: "com.example.other" } }] } : { publisherId: "pub-1", reportingTimeZone: "America/Los_Angeles", currencyCode: "USD" };
  }), /APP_IDENTITY_MISMATCH/);
  assert.ok(!calls.some((path) => path.includes("networkReport")));
});
