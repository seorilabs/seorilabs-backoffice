import { prisma } from "@/lib/prisma";
import { getConsoleSyncStatus, ingestConsoleMetrics } from "@/lib/core/console-metrics-collect";
import { recordCollectionFailure } from "../coverage";
import { consoleCollectionPlan } from "./plan";
import { ConsoleSyncError, consoleErrorCode } from "./oauth";
import type { McpConsoleMetricsSource } from "./source";

// 갱신 전에 잠금을 잡는다. 여러 수집 Job이 같은 refresh token을 동시에 쓰지 않는다.
export async function withConsoleCollectionLock<T>(run: () => Promise<T>): Promise<T | { state: "already_running" }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ acquired: number | bigint | null }>>`SELECT GET_LOCK('backoffice:ait-console-collect', 0) AS acquired`;
    if (Number(rows[0]?.acquired) !== 1) return { state: "already_running" as const };
    try { return await run(); }
    finally { await tx.$queryRaw`SELECT RELEASE_LOCK('backoffice:ait-console-collect')`; }
  }, { timeout: 840_000, maxWait: 5_000 });
}
export async function collectConsoleMetrics(source: McpConsoleMetricsSource, now: Date, launches: Record<string, string> = {}) {
  const plan = consoleCollectionPlan(await getConsoleSyncStatus(), now, launches);
  const registry = await prisma.app.findMany({ select: { id: true, slug: true } });
  const appIds = new Map(registry.map((app) => [app.slug, app.id]));
  const results = [];
  for (const window of plan.windows) {
    let response: Awaited<ReturnType<McpConsoleMetricsSource["queryListing"]>>;
    try { response = await source.queryListing(window, window.start, window.end); }
    catch (error) {
      if (consoleErrorCode(error) !== "RATE_LIMITED") throw error;
      for (const remaining of plan.windows.slice(results.length)) plan.blocked.push({ key: `${remaining.slug}#${remaining.miniAppId}`, reason: "공급자 요청 제한으로 실행 보류" });
      break;
    }
    const appId = appIds.get(window.slug);
    if (appId) await recordCollectionFailure(response.missing.map((missing) => ({ source: "ait_console" as const, appId, listingId: window.miniAppId, day: missing.date, detail: `미확인 지표: ${missing.metrics.join(",")}` })), now);
    const stored = response.days.length ? await ingestConsoleMetrics({ apps: [{ ...window, days: response.days }] }, now) : null;
    results.push({ window, upserts: stored?.upserts ?? 0, missing: response.missing, errors: response.errors,
      skipped: stored?.skipped ?? [], storageErrors: stored?.errors ?? [], warnings: stored?.warnings ?? [] });
  }
  const readback = await getConsoleSyncStatus();
  const incomplete = plan.blocked.length > 0 || results.some((r) => r.missing.length || r.errors.length || r.skipped.length || r.storageErrors.length || r.warnings.length)
    || readback.apps.some((a) => a.lastDate !== plan.end);
  if (!results.length && !plan.blocked.length) throw new ConsoleSyncError("CONSOLE_NO_TARGETS");
  return { state: incomplete ? "partial" as const : "complete" as const, end: plan.end, blocked: plan.blocked, results, readback };
}
