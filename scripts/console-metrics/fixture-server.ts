import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CONSOLE_READ_TOOLS } from "../../src/lib/analytics/console-sync/client";
import { metricDaysBetween, metricDayWindow } from "../../src/lib/analytics/metric-day";
import { MCP_URL, TOKEN_URL } from "../../src/lib/analytics/console-sync/oauth";

// 실제 공급자를 호출하지 않는 loopback 전용 프로토콜 시험 서버.
// 2026-10-13 실제 tools/list 계약: 날짜·집계·OS 입력은 request 안에 있어야 한다.
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const period = { startDate: date, endDate: date };
const unit = z.enum(["DAY", "WEEK", "MONTH"]);
function inputSchema(name: string) {
  if (name === "workspace_overview") return z.object({}).strict();
  const request = name === "dashboard_revenue_iaa" ? z.object({ ...period, osType: z.enum(["IOS", "ANDROID"]).optional() }).strict()
    : name === "dashboard_revenue_iap" ? z.object({ ...period, timeUnitType: unit }).strict()
    : name === "dashboard_session" ? z.object({ ...period, timeUnit: unit.optional() }).strict()
    : z.object({ ...period, timeUnit: unit }).strict();
  return z.object({ workspaceId: z.number().int(), miniAppId: z.number().int(), request }).strict();
}
export async function startConsoleFixture() {
  const state = { failIos: false, revoked: false, rateLimits: 0, unavailable: 0, retryAfter: "0", refreshes: 0, active: 0, maxActive: 0, tools: [] as string[] };
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/token") { state.refreshes++; res.setHeader("Content-Type", "application/json"); res.statusCode = state.revoked ? 400 : 200; res.end(JSON.stringify(state.revoked ? { error: "invalid_grant" } : { access_token: "fixture-access", token_type: "bearer", expires_in: 3600, refresh_token: "fixture-refresh" })); return; }
      if (req.headers.authorization !== "Bearer fixture-access") { res.writeHead(401).end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      if (body?.method === "tools/call" && state.rateLimits > 0) { state.rateLimits--; res.writeHead(429, { "Retry-After": state.retryAfter }).end(); return; }
      if (body?.method === "tools/call" && state.unavailable > 0) { state.unavailable--; res.writeHead(503, { "Retry-After": state.retryAfter }).end(); return; }
      const mcp = new McpServer({ name: "isolated-console", version: "1" });
      for (const name of CONSOLE_READ_TOOLS) mcp.registerTool(name, { inputSchema: inputSchema(name) }, async (args) => {
        state.tools.push(name); state.active++; state.maxActive = Math.max(state.active, state.maxActive);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (name === "workspace_overview") return { content: [{ type: "text", text: JSON.stringify({ workspaces: [{ id: 38345 }] }) }] };
          const request = (args as Record<string, unknown>).request as { startDate: string; endDate: string; osType?: string };
          const start = request.startDate; const end = request.endDate;
          const dates = metricDayWindow(end, metricDaysBetween(end, start) + 1);
          let result: unknown;
          if (name === "dashboard_dau") result = { au: [], newAu: [], age: [], gender: [], referrer: [] };
          if (name === "dashboard_session") result = { metric: dates.map((dateKey) => ({ dateKey, value: 30 })) };
          if (name === "dashboard_revenue_iap") result = { metric: dates.map((trxDate) => ({ trxDate, trxAmount: 0, settlementAmount: 0, pu: 0 })) };
          if (name === "dashboard_revenue_iaa") result = { dailyReports: dates.flatMap((date) => state.failIos && request.osType === "IOS" ? [] : [{ date, impression: request.osType === "IOS" ? 0 : 6, estimatedEarning: request.osType === "IOS" ? 0 : 34, ecpm: 5 }]) };
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } finally { state.active--; }
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport); await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address();
  if (!address || typeof address === "string") throw new Error("FIXTURE_SERVER_FAILED");
  const base = `http://127.0.0.1:${address.port}`;
  const fetcher: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== TOKEN_URL && url !== MCP_URL) throw new Error("FIXTURE_EXTERNAL_REQUEST_BLOCKED");
    return fetch(`${base}${url === TOKEN_URL ? "/token" : "/mcp"}`, init);
  };
  return { state, fetcher, close: () => new Promise<void>((resolve, reject) => { server.close((e) => e ? reject(e) : resolve()); server.closeAllConnections(); }) };
}
