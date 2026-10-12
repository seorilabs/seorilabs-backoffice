import { z } from "zod";
import { AIT_WORKSPACE_ID, AIT_LISTINGS } from "../ait-apps";
import { containsConsoleSecret, type ConsoleMetricsSource, type ConsoleSourceTarget } from "../console-source";
import type { ConsoleReader, ConsoleReadTool } from "./client";
import { normalizeConsoleResponses } from "./mapper";
import { ConsoleSyncError, consoleErrorCode } from "./oauth";
const fatal = new Set(["REAUTHENTICATION_REQUIRED", "OAUTH_ROTATION_REQUIRES_REVIEW", "OAUTH_REFRESH_OUTCOME_UNKNOWN", "OAUTH_CLIENT_CONFIGURATION_INVALID", "OAUTH_RESOURCE_CONFIGURATION_INVALID", "OAUTH_REFRESH_NOT_SUPPORTED", "OAUTH_REQUEST_REJECTED", "RATE_LIMITED"]);
export class McpConsoleMetricsSource implements ConsoleMetricsSource {
  constructor(private readonly reader: ConsoleReader) {}
  async verifyWorkspace() {
    const result = z.object({ workspaces: z.array(z.object({ id: z.number() })) }).safeParse(await this.reader.call("workspace_overview", {}));
    if (!result.success || !result.data.workspaces.some((w) => w.id === AIT_WORKSPACE_ID)) throw new ConsoleSyncError("CONSOLE_WORKSPACE_MISMATCH");
  }
  async queryListing(target: ConsoleSourceTarget, start: string, end: string) {
    if (target.workspaceId !== AIT_WORKSPACE_ID || !AIT_LISTINGS.some((l) => l.appSlug === target.slug && l.miniAppId === target.miniAppId)) throw new ConsoleSyncError("CONSOLE_LISTING_MISMATCH");
    const common = { workspaceId: target.workspaceId, miniAppId: target.miniAppId };
    const period = { startDate: start, endDate: end };
    const requests: Array<[string, ConsoleReadTool, Record<string, unknown>]> = [
      ["dau", "dashboard_dau", { ...common, request: { ...period, timeUnit: "DAY" } }], ["session", "dashboard_session", { ...common, request: { ...period, timeUnit: "DAY" } }],
      ["android", "dashboard_revenue_iaa", { ...common, request: { ...period, osType: "ANDROID" } }], ["ios", "dashboard_revenue_iaa", { ...common, request: { ...period, osType: "IOS" } }],
      ["iap", "dashboard_revenue_iap", { ...common, request: { ...period, timeUnitType: "DAY" } }],
    ];
    const responses: Record<string, unknown> = {}; const errors: { metric: string; code: string }[] = [];
    for (let offset = 0; offset < requests.length; offset += 2) {
      const results = await Promise.allSettled(requests.slice(offset, offset + 2).map(async ([key, tool, args]) => {
        const response = await this.reader.call(tool, args);
        if (containsConsoleSecret(response)) throw new ConsoleSyncError("CONSOLE_RESPONSE_CONTAINS_CREDENTIAL");
        return { key, response };
      }));
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") responses[result.value.key] = result.value.response;
        else { const code = consoleErrorCode(result.reason); if (fatal.has(code)) throw new ConsoleSyncError(code); errors.push({ metric: requests[offset + index][0], code }); }
      }
    }
    return { ...normalizeConsoleResponses(responses, start, end), errors };
  }
  async queryConsoleMetrics(target: ConsoleSourceTarget, start: string, end: string) { return (await this.queryListing(target, start, end)).days; }
}
