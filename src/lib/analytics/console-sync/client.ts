import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConsoleOAuth, ConsoleSyncError, MCP_URL } from "./oauth";
export const CONSOLE_READ_TOOLS = ["workspace_overview", "dashboard_dau", "dashboard_session", "dashboard_revenue_iaa", "dashboard_revenue_iap"] as const;
export type ConsoleReadTool = typeof CONSOLE_READ_TOOLS[number];
export interface ConsoleReader { call(tool: ConsoleReadTool, args: Record<string, unknown>): Promise<unknown>; }
export function retryDelay(response: Response) {
  if (![429, 502, 503, 504].includes(response.status)) return null;
  const raw = response.headers.get("Retry-After");
  const seconds = raw == null ? 1 : /^\d+$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 30 ? Math.max(100, seconds * 1000) : null;
}
export async function createConsoleReader(oauth: ConsoleOAuth) {
  const client = new Client({ name: "backoffice-console-metrics", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1_000, initialReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 }, fetch: async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const response = await oauth.fetch(input, init); const delay = retryDelay(response);
      if (delay == null || attempt >= 2) return response;
      await response.body?.cancel(); await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }});
  try { await client.connect(transport); } catch { await client.close().catch(() => {}); throw new ConsoleSyncError(oauth.failureCode ?? "MCP_CONNECT_FAILED"); }
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async call(tool: ConsoleReadTool, args: Record<string, unknown>): Promise<unknown> {
      if (!(CONSOLE_READ_TOOLS as readonly string[]).includes(tool)) throw new ConsoleSyncError("MCP_TOOL_NOT_ALLOWED");
      if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve)); else active++;
      try {
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 30_000 });
        if (result.isError) throw new ConsoleSyncError("MCP_TOOL_FAILED");
        if (result.structuredContent) return result.structuredContent;
        const content = result.content as Array<{ type: string; text?: string }>;
        if (content?.length !== 1 || content[0].type !== "text" || !content[0].text) throw new ConsoleSyncError("MCP_RESPONSE_INVALID");
        try { return JSON.parse(content[0].text); } catch { throw new ConsoleSyncError("MCP_RESPONSE_INVALID"); }
      } catch (error) { throw new ConsoleSyncError(oauth.failureCode ?? (error instanceof ConsoleSyncError ? error.code : "MCP_TOOL_FAILED")); }
      finally { const next = waiting.shift(); if (next) next(); else active--; }
    }, close: () => client.close(),
  };
}
