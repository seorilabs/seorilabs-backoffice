import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CONSOLE_READ_TOOLS } from "../../src/lib/analytics/console-sync/client";
import { metricDaysBetween, metricDayWindow } from "../../src/lib/analytics/metric-day";
import { MCP_URL, TOKEN_URL } from "../../src/lib/analytics/console-sync/oauth";

// 실제 공급자를 호출하지 않는 loopback 전용 프로토콜 시험 서버.
export async function startConsoleFixture() {
  const state = { failIos: false, revoked: false, rateLimits: 0, retryAfter: "0", refreshes: 0, active: 0, maxActive: 0, tools: [] as string[] };
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/token") { state.refreshes++; res.setHeader("Content-Type", "application/json"); res.statusCode = state.revoked ? 400 : 200; res.end(JSON.stringify(state.revoked ? { error: "invalid_grant" } : { access_token: "fixture-access", token_type: "bearer", expires_in: 3600 })); return; }
      if (req.headers.authorization !== "Bearer fixture-access") { res.writeHead(401).end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      if (body?.method === "tools/call" && state.rateLimits > 0) { state.rateLimits--; res.writeHead(429, { "Retry-After": state.retryAfter }).end(); return; }
      const mcp = new McpServer({ name: "isolated-console", version: "1" });
      for (const name of CONSOLE_READ_TOOLS) mcp.registerTool(name, { inputSchema: z.object({}).passthrough() }, async (args) => {
        state.tools.push(name); state.active++; state.maxActive = Math.max(state.active, state.maxActive);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (name === "workspace_overview") return { content: [{ type: "text", text: JSON.stringify({ workspaces: [{ id: 38345 }] }) }] };
          const start = args.startDate as string; const end = args.endDate as string;
          const dates = metricDayWindow(end, metricDaysBetween(end, start) + 1);
          let result: unknown;
          if (name === "dashboard_dau") result = { au: [], newAu: [], age: [], gender: [], referrer: [] };
          if (name === "dashboard_session") result = { metric: dates.map((dateKey) => ({ dateKey, value: 30 })) };
          if (name === "dashboard_revenue_iap") result = { metric: dates.map((trxDate) => ({ trxDate, trxAmount: 0, settlementAmount: 0, pu: 0 })) };
          if (name === "dashboard_revenue_iaa") result = { dailyReports: dates.flatMap((date) => state.failIos && args.osType === "IOS" ? [] : [{ date, impression: args.osType === "IOS" ? 0 : 6, estimatedEarning: args.osType === "IOS" ? 0 : 34, ecpm: 5 }]) };
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
