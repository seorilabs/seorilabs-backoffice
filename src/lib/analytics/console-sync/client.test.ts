import assert from "node:assert/strict";
import test from "node:test";
import { startConsoleFixture } from "../../../../scripts/console-metrics/fixture-server";
import { createConsoleReader, retryDelay, type ConsoleReadTool } from "./client";
import { ConsoleOAuth } from "./oauth";
import { McpConsoleMetricsSource } from "./source";
test("실제 HTTP MCP에서 갱신·429·병렬 상한·allowlist·부분 결측을 검증한다", async () => {
  const fixture = await startConsoleFixture();
  const oauth = new ConsoleOAuth({ credentialId: "shared/apps-in-toss/console-oauth", clientId: "mcp-gateway", refreshToken: "fixture-refresh" }, fixture.fetcher);
  const reader = await createConsoleReader(oauth);
  try {
    const source = new McpConsoleMetricsSource(reader); await source.verifyWorkspace(); fixture.state.rateLimits = 1;
    const target = { slug: "lizard-tycoon", workspaceId: 38345, miniAppId: 61736 };
    const result = await source.queryListing(target, "2026-10-10", "2026-10-11"); assert.equal(result.days.length, 2); assert.equal(result.errors.length, 0);
    assert.equal(fixture.state.refreshes, 1);
    await Promise.all(Array.from({ length: 6 }, () => reader.call("dashboard_dau", { workspaceId: 38345, miniAppId: 61736, startDate: "2026-10-11", endDate: "2026-10-11" })));
    assert.ok(fixture.state.maxActive <= 2);
    const before = fixture.state.tools.length; await assert.rejects(reader.call("deploy" as ConsoleReadTool, {}), /MCP_TOOL_NOT_ALLOWED/); assert.equal(fixture.state.tools.length, before);
    fixture.state.failIos = true;
    const missing = await source.queryListing(target, "2026-10-11", "2026-10-11"); assert.equal(missing.days.length, 0); assert.deepEqual(missing.missing[0].metrics, ["iaa.IOS"]);
    fixture.state.rateLimits = 10;
    await assert.rejects(source.queryListing(target, "2026-10-11", "2026-10-11"), /RATE_LIMITED/);
  } finally { await reader.close(); await fixture.close(); }
});
test("긴 Retry-After와 비정상 값은 자동 재시도하지 않는다", () => {
  for (const value of ["60", "nonsense", "-2"]) assert.equal(retryDelay(new Response(null, { status: 429, headers: { "Retry-After": value } })), null);
  assert.equal(retryDelay(new Response(null, { status: 503 })), 1000); assert.equal(retryDelay(new Response(null, { status: 400 })), null);
});

test("요청 전체 예산이 끝나면 대기 중인 재시도를 취소하고 다음 슬롯을 넘긴다", async () => {
  const fixture = await startConsoleFixture();
  const oauth = new ConsoleOAuth({ credentialId: "shared/apps-in-toss/console-oauth", clientId: "mcp-gateway", refreshToken: "fixture-refresh" }, fixture.fetcher);
  const reader = await createConsoleReader(oauth, { requestBudgetMs: 1_000 });
  try {
    fixture.state.unavailable = 10; fixture.state.retryAfter = "2";
    await assert.rejects(reader.call("dashboard_dau", { workspaceId: 38345, miniAppId: 61736, startDate: "2026-10-11", endDate: "2026-10-11" }), /MCP_REQUEST_TIMEOUT/);
    const remaining = fixture.state.unavailable;
    await new Promise((resolve) => setTimeout(resolve, 150)); assert.equal(fixture.state.unavailable, remaining);
  } finally { await reader.close(); await fixture.close(); }
});
test("Retry-After 20초 연속 응답에서 남은 예산을 넘기면 전체 조회를 멈춘다", async () => {
  const fixture = await startConsoleFixture();
  const oauth = new ConsoleOAuth({ credentialId: "shared/apps-in-toss/console-oauth", clientId: "mcp-gateway", refreshToken: "fixture-refresh" }, fixture.fetcher);
  const reader = await createConsoleReader(oauth);
  try {
    fixture.state.rateLimits = 10; fixture.state.retryAfter = "20";
    await assert.rejects(reader.call("dashboard_dau", { workspaceId: 38345, miniAppId: 61736, startDate: "2026-10-11", endDate: "2026-10-11" }), /RATE_LIMITED/);
    const left = fixture.state.rateLimits; assert.equal(left, 8);
    await assert.rejects(reader.call("dashboard_session", {}), /RATE_LIMITED/); assert.equal(fixture.state.rateLimits, left);
  } finally { await reader.close(); await fixture.close(); }
});
