import { z } from "zod";
import { prisma } from "../src/lib/prisma";
import { AIT_LISTINGS, AIT_WORKSPACE_ID } from "../src/lib/analytics/ait-apps";
import { lastElapsedMetricDay, parseMetricDay } from "../src/lib/analytics/metric-day";
import { createConsoleReader } from "../src/lib/analytics/console-sync/client";
import { collectConsoleMetrics, withConsoleCollectionLock } from "../src/lib/analytics/console-sync/collect";
import { ConsoleOAuth, ConsoleSyncError, consoleErrorCode } from "../src/lib/analytics/console-sync/oauth";
import { SecretManagerConsoleGrantVersions } from "../src/lib/analytics/console-sync/versions";
import { consoleRuntimeLedger } from "../src/lib/control-plane/console-oauth-runtime";
import { McpConsoleMetricsSource } from "../src/lib/analytics/console-sync/source";
import { collectAndNotify } from "../src/lib/analytics/console-sync/notification";
import { consoleExecutionFailed } from "../src/lib/analytics/console-sync/execution";
import { beginCollection, completeCollection } from "../src/lib/insights/collection";

async function execute(mode: string) {
  if (!["collect", "verify-auth", "verify-refresh"].includes(mode)) throw new ConsoleSyncError("CONSOLE_MODE_INVALID");

  let launches: Record<string, string>;
  try { launches = z.record(z.string().refine((v) => parseMetricDay(v) !== null)).parse(JSON.parse(process.env.AIT_CONSOLE_CONFIRMED_LAUNCHES ?? "{}")); }
  catch { throw new ConsoleSyncError("CONSOLE_LAUNCH_DATES_INVALID"); }
  const run = async (assertHeld: () => Promise<void>) => {
    if (process.env.AIT_CONSOLE_CREDENTIAL_ID !== "shared/apps-in-toss/console-oauth") throw new ConsoleSyncError("OAUTH_IDENTITY_MISMATCH");
    const runtime = consoleRuntimeLedger({ kind: "worker", principal: process.env.AIT_CONSOLE_RUNTIME_PRINCIPAL ?? "", workspaceId: 38345 }, assertHeld);
    const versions = await SecretManagerConsoleGrantVersions.fromWif(process.env.AIT_CONSOLE_SECRET_RESOURCE ?? "", process.env.AIT_CONSOLE_WIF_CONFIG ?? "", process.env.AIT_CONSOLE_WIF_AUDIENCE ?? "");
    const oauth = await ConsoleOAuth.open(versions, runtime);
    if (mode === "verify-refresh") await oauth.refresh();
    const reader = await createConsoleReader(oauth);
    try {
      const source = new McpConsoleMetricsSource(reader); await source.verifyWorkspace();
      if (mode !== "collect") {
        const date = lastElapsedMetricDay(new Date()); const listing = AIT_LISTINGS[0];
        const result = await source.queryListing({ slug: listing.appSlug, workspaceId: AIT_WORKSPACE_ID, miniAppId: listing.miniAppId }, date, date);
        return { state: "authenticated" as const, mode, metricDays: result.days.length, missing: result.missing, errors: result.errors };
      }
      return await collectConsoleMetrics(source, new Date(), launches);
    } finally { await reader.close().catch(() => {}); }
  };
  // 검사 모드도 수집과 같은 잠금 범위를 사용한다. DB에는 지표를 저장하지 않는다.
  return await withConsoleCollectionLock(run);
}
async function main() {
  const mode = process.argv[2] ?? "collect";
  const ledger = mode === "collect" ? await beginCollection("ait-console-run", `workspace:${AIT_WORKSPACE_ID}`) : null;
  const result = mode === "collect" ? await collectAndNotify(() => execute(mode)) : { ...await execute(mode), notification: undefined };
  const failed = consoleExecutionFailed(result);
  if (ledger) await completeCollection(ledger.id, { status: failed ? "failed" : result.state,
    coverage: JSON.parse(JSON.stringify(result)) });
  (result.state === "failed" ? process.stderr : process.stdout).write(`${JSON.stringify(result)}\n`);
  if (failed) process.exitCode = 1;
}
main().catch((error) => { process.stderr.write(`${JSON.stringify({ state: "failed", code: consoleErrorCode(error) })}\n`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect().catch(() => {}));
