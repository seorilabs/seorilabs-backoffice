import assert from "node:assert/strict";
import test from "node:test";
import type { ConsoleReader } from "./client";
import { McpConsoleMetricsSource } from "./source";

test("공식 합계와 양 OS를 독립 조회하고 동시 요청은 2개를 넘지 않는다", async () => {
  let active = 0, peak = 0; const requests: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const sample = { dau: { au: [], newAu: [] }, session: { metric: [] }, iap: { metric: [{ trxDate: "2026-10-11", trxAmount: 0, settlementAmount: 0, pu: 0 }] }, ios: { dailyReports: [{ date: "2026-10-11", impression: 1, estimatedEarning: 4 }] } };
  const reader = { call: async (tool: string, args: Record<string, unknown>) => {
    active++; peak = Math.max(peak, active); requests.push({ tool, args });
    await new Promise((resolve) => setTimeout(resolve, 1)); active--;
    const request = args.request as { osType?: string };
    if (tool === "dashboard_dau") return sample.dau;
    if (tool === "dashboard_session") return sample.session;
    if (tool === "dashboard_revenue_iap") return sample.iap;
    if (request.osType === "ANDROID") return { dailyReports: [] };
    if (request.osType === "IOS") return sample.ios;
    return { dailyReports: [{ date: "2026-10-11", impression: 1, estimatedEarning: 4 }] };
  } } as unknown as ConsoleReader;
  const result = await new McpConsoleMetricsSource(reader).queryListing({ slug: "lizard-tycoon", workspaceId: 38345, miniAppId: 61736 }, "2026-10-11", "2026-10-11");
  assert.equal(requests.length, 6); assert.equal(peak, 2);
  assert.equal(result.days[0].iaaEarningKrw, 4); assert.deepEqual(result.missing[0].metrics, ["iaa.ANDROID"]);
});


test("비정상 응답은 정상 조회의 빈 배열과 구분해 실행 오류로 남긴다", async () => {
  const reader = { async call() { return { unexpected: [] }; } } as unknown as ConsoleReader;
  const result = await new McpConsoleMetricsSource(reader).queryListing({ slug: "lizard-tycoon", workspaceId: 38345, miniAppId: 61736 }, "2026-10-11", "2026-10-11");
  assert.equal(result.errors.length, 6);
  assert.ok(result.errors.every((error) => error.code === "CONSOLE_RESPONSE_INVALID"));
});
