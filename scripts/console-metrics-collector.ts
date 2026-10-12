import { z } from "zod";
import { prisma } from "../src/lib/prisma";
import { AIT_LISTINGS, AIT_WORKSPACE_ID } from "../src/lib/analytics/ait-apps";
import { lastElapsedMetricDay, parseMetricDay } from "../src/lib/analytics/metric-day";
import { createConsoleReader } from "../src/lib/analytics/console-sync/client";
import { collectConsoleMetrics, withConsoleCollectionLock } from "../src/lib/analytics/console-sync/collect";
import { ConsoleOAuth, ConsoleSyncError, consoleErrorCode, loadConsoleCredential } from "../src/lib/analytics/console-sync/oauth";
import { McpConsoleMetricsSource } from "../src/lib/analytics/console-sync/source";

async function main() {
  const mode = process.argv[2] ?? "collect";
  if (!["collect", "verify-auth", "verify-refresh"].includes(mode)) throw new ConsoleSyncError("CONSOLE_MODE_INVALID");
  const credential = await loadConsoleCredential(process.env.AIT_CONSOLE_OAUTH_FILE, process.env.AIT_CONSOLE_CREDENTIAL_ID);
  let launches: Record<string, string>;
  try { launches = z.record(z.string().refine((v) => parseMetricDay(v) !== null)).parse(JSON.parse(process.env.AIT_CONSOLE_CONFIRMED_LAUNCHES ?? "{}")); }
  catch { throw new ConsoleSyncError("CONSOLE_LAUNCH_DATES_INVALID"); }
  const run = async () => {
    const oauth = new ConsoleOAuth(credential);
    if (mode === "verify-refresh") await oauth.refresh();
    const reader = await createConsoleReader(oauth);
    try {
      const source = new McpConsoleMetricsSource(reader); await source.verifyWorkspace();
      if (mode !== "collect") {
        const date = lastElapsedMetricDay(new Date()); const listing = AIT_LISTINGS[0];
        const result = await source.queryListing({ slug: listing.appSlug, workspaceId: AIT_WORKSPACE_ID, miniAppId: listing.miniAppId }, date, date);
        return { state: "authenticated", mode, metricDays: result.days.length, missing: result.missing, errors: result.errors };
      }
      return collectConsoleMetrics(source, new Date(), launches);
    } finally { await reader.close().catch(() => {}); }
  };
  // 검사 모드도 수집과 같은 잠금 범위를 사용한다. DB에는 지표를 저장하지 않는다.
  const result = await withConsoleCollectionLock(run);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.state === "partial") process.exitCode = 2;
}
main().catch((error) => { process.stderr.write(`${JSON.stringify({ state: "failed", code: consoleErrorCode(error) })}\n`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect().catch(() => {}));
