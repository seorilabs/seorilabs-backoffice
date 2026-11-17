import { dbDay, shiftMetricDay, toDbDay } from "../metric-day";
import { consoleMetricPoints } from "./insight-points";
import type { MetricCollectionPoint } from "@/lib/insights/metric-collection-facts";
import { AIT_LISTINGS } from "../ait-apps";
import { prisma } from "@/lib/prisma";
import { getConsoleSyncStatus, ingestConsoleMetrics } from "@/lib/core/console-metrics-collect";
import { recordCollectionFailure, recordObservations } from "../coverage";
import { consoleCollectionPlan } from "./plan";
import { ConsoleSyncError, consoleErrorCode } from "./oauth";
import type { McpConsoleMetricsSource } from "./source";
import { verifyStoredConsoleDays } from "./readback";

// 갱신 전에 잠금을 잡는다. 여러 수집 Job이 같은 refresh token을 동시에 쓰지 않는다.
export async function withConsoleCollectionLock<T>(run: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T | { state: "already_running" }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ acquired: number | bigint | null }>>`SELECT GET_LOCK('backoffice:ait-console-collect', 0) AS acquired`;
    if (Number(rows[0]?.acquired) !== 1) return { state: "already_running" as const };
    const assertHeld = async () => {
      const held = await tx.$queryRaw<Array<{ held: number | bigint | null }>>`SELECT IS_USED_LOCK('backoffice:ait-console-collect') = CONNECTION_ID() AS held`;
      if (Number(held[0]?.held) !== 1) throw new ConsoleSyncError("OAUTH_COLLECTION_LOCK_LOST");
    };
    try { return await run(assertHeld); }
    finally { await tx.$queryRaw`SELECT RELEASE_LOCK('backoffice:ait-console-collect')`; }
  }, { timeout: 840_000, maxWait: 5_000 });
}
export async function collectConsoleMetrics(source: McpConsoleMetricsSource, now: Date, launches: Record<string, string> = {}, retryFrom?: string) {
  const status = await getConsoleSyncStatus();
  const plan = consoleCollectionPlan(status, now, launches, retryFrom);
  const registry = await prisma.app.findMany({ select: { id: true, slug: true, displayName: true, status: true, aitMiniAppId: true } });
  const declared = registry.filter((app) => app.aitMiniAppId != null || AIT_LISTINGS.some((listing) => listing.appSlug === app.slug));
  const noActiveTargets = !status.apps.length && declared.length > 0 && declared.every((app) => app.status !== "ACTIVE")
    && AIT_LISTINGS.every((listing) => registry.some((app) => app.slug === listing.appSlug));
  if (noActiveTargets) plan.blocked.length = 0;
  const appIds = new Map(registry.map((app) => [app.slug, app.id]));
  const results = [];
  const metricPoints: MetricCollectionPoint[] = [];
  for (const window of plan.windows) {
    let response: Awaited<ReturnType<McpConsoleMetricsSource["queryListing"]>>;
    // 전날은 새벽 회차에 집계가 덜 끝났을 수 있어 그날의 행 부재만 0으로 확정하지 않는다.
    try { response = await source.queryListing(window, window.start, window.end, window.end === plan.end ? shiftMetricDay(plan.end, -1) : window.end); }
    catch (error) {
      if (consoleErrorCode(error) !== "RATE_LIMITED") throw error;
      for (const remaining of plan.windows.slice(results.length)) plan.blocked.push({ key: `${remaining.slug}#${remaining.miniAppId}`, reason: "공급자 요청 제한으로 실행 보류" });
      break;
    }
    const appId = appIds.get(window.slug);
    if (appId) {
      await recordCollectionFailure(response.missing.map((missing) => ({ source: "ait_console" as const, appId, listingId: window.miniAppId, day: missing.date, detail: `미확인 지표: ${missing.metrics.join(",")}` })), now);
      const stored = new Set(response.days.map((day) => day.date));
      // 이미 값이 저장된 날짜는 활동 0으로 기록하지 않는다.
      const saved = response.emptyDates.length ? await prisma.appConsoleMetricDaily.findMany({ where: { appId, miniAppId: window.miniAppId, date: { in: response.emptyDates.map(toDbDay) } }, select: { date: true } }) : [];
      const savedDays = new Set(saved.map((row) => dbDay(row.date)));
      await recordObservations([
        ...response.emptyDates.filter((day) => !savedDays.has(day)).map((day) => ({ source: "ait_console" as const, appId, listingId: window.miniAppId, day, state: "empty" as const })),
        ...response.pending.filter((row) => !stored.has(row.date) && !response.missing.some((missing) => missing.date === row.date))
          .map((row) => ({ source: "ait_console" as const, appId, listingId: window.miniAppId, day: row.date, state: "not_landed" as const, detail: "집계 대기" })),
      ], now);
    }
    const stored = response.days.length ? await ingestConsoleMetrics({ apps: [{ ...window, days: response.days }] }, now) : null;
    const excluded = stored?.skipped.some((row) => row.category === "excluded") && !stored.upserts;
    let verification = excluded ? { expected: 0, verified: 0, mismatched: [] as string[] } : { expected: response.days.length, verified: 0, mismatched: response.days.map((day) => day.date) };
    const storageErrors = [...(stored?.errors ?? [])];
    try {
      if (appId && !excluded) verification = await verifyStoredConsoleDays(appId, window.miniAppId, response.days, now);
      if (verification.mismatched.length) storageErrors.push({ key: `${window.slug}#${window.miniAppId}`, error: "CONSOLE_READBACK_MISMATCH" });
    } catch { storageErrors.push({ key: `${window.slug}#${window.miniAppId}`, error: "CONSOLE_READBACK_FAILED" }); }
    if (!excluded) metricPoints.push(...consoleMetricPoints(window.slug, window.miniAppId,
      response.days.filter(day => day.date >= shiftMetricDay(plan.end, -1) && !verification.mismatched.includes(day.date)), registry.find(app => app.id === appId)?.displayName));
    results.push({ window, providedDates: excluded ? [] : response.days.map((day) => day.date), upserts: stored?.upserts ?? 0, missing: response.missing, pending: response.pending, emptyDates: response.emptyDates, errors: response.errors,
      skipped: stored?.skipped ?? [], storageErrors, warnings: stored?.warnings ?? [], verification });
  }
  const readback = await getConsoleSyncStatus();
  const incomplete = plan.blocked.length > 0 || results.some((r) => r.missing.length || r.pending.length || r.errors.length || r.skipped.length || r.storageErrors.length || r.warnings.length)
    || readback.apps.some((a) => a.lastDate !== plan.end);
  if (!results.length && !plan.blocked.length && !noActiveTargets) throw new ConsoleSyncError("CONSOLE_NO_TARGETS");
  return { state: incomplete || noActiveTargets ? "partial" as const : "complete" as const,
    ...(noActiveTargets ? { skipReason: "등록된 모든 앱이 운영 중지여서 이번 실행은 수집하지 않았습니다." } : {}), end: plan.end, blocked: plan.blocked, results, readback, ...(metricPoints.length ? { metricPoints } : {}) };
}
