import { setTimeout as delayFor } from "node:timers/promises";
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
export async function createConsoleReader(oauth: ConsoleOAuth, { requestBudgetMs = 25_000 } = {}) {
  if (requestBudgetMs <= 0 || requestBudgetMs > 25_000) throw new ConsoleSyncError("MCP_REQUEST_BUDGET_INVALID");
  let cooldownUntil = 0; let rateLimited = false;
  const client = new Client({ name: "backoffice-console-metrics", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1_000, initialReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 }, fetch: async (input, init) => {
    const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(requestBudgetMs)]);
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        if (rateLimited) throw new ConsoleSyncError("RATE_LIMITED");
        const cooldown = cooldownUntil - Date.now();
        if (cooldown > 0) await delayFor(cooldown, undefined, { signal });
        const response = await oauth.fetch(input, { ...init, signal }); const delay = retryDelay(response);
        if (response.status === 429) {
          if (delay == null || attempt >= 2) { await response.body?.cancel(); rateLimited = true; throw new ConsoleSyncError("RATE_LIMITED"); }
          cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
        }
        if (delay == null || attempt >= 2) return response;
        await response.body?.cancel();
        if (response.status !== 429) await delayFor(delay, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) throw new ConsoleSyncError("MCP_REQUEST_TIMEOUT");
      throw error;
    }
  }});
  try { await client.connect(transport); } catch (error) { await client.close().catch(() => {}); throw new ConsoleSyncError(oauth.failureCode ?? (error instanceof ConsoleSyncError ? error.code : "MCP_CONNECT_FAILED")); }
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async call(tool: ConsoleReadTool, args: Record<string, unknown>): Promise<unknown> {
      if (!(CONSOLE_READ_TOOLS as readonly string[]).includes(tool)) throw new ConsoleSyncError("MCP_TOOL_NOT_ALLOWED");
      if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve)); else active++;
      try {
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: requestBudgetMs + 5_000 });
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
