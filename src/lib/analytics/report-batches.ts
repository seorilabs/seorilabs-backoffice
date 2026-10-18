import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { metricReportBatchSchema, type MetricReportBatchInput } from "./source-contract";
import { toDbDay, dbDay, shiftMetricDay } from "./metric-day";
import { unifiedMetricRowSchema } from "./unified-metrics";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { retryPrismaConflict } from "@/lib/prisma-conflict";

/** 출처·대상·설정 결속을 확인한 완전한 report partition만 append한다. */
export async function importMetricReport(input: MetricReportBatchInput, runId: string) {
  const batch = metricReportBatchSchema.parse(input);
  const uri = new URL(batch.sourceUri);
  if (!(["https:", "gs:"].includes(uri.protocol)) || uri.username || uri.password || uri.search || uri.hash) throw new Error("REPORT_SOURCE_URI_INVALID");
  if (batch.source === "apple-analytics" && (uri.origin !== "https://api.appstoreconnect.apple.com" || !/^\/v1\/analyticsReportInstances\/[A-Za-z0-9-]+$/.test(uri.pathname))
    || batch.source === "admob" && batch.sourceUri !== `https://admob.googleapis.com/v1/accounts/${batch.accountId}/networkReport`
    || batch.source === "play-reports" && (uri.protocol !== "gs:" || uri.hostname !== batch.accountId || !uri.pathname.startsWith(`/stats/installs/installs_${batch.resourceId}_`) || !/\d{6}_country\.csv$/.test(uri.pathname))) throw new Error("REPORT_SOURCE_URI_MISMATCH");
  return retryPrismaConflict(() => prisma.$transaction(async (db) => {
    const revision = await db.configRevision.findFirst({ where: { id: batch.configRevisionId, appId: batch.appId, status: "ACTIVE" } });
    if (!revision) throw new Error("REPORT_CONFIG_STALE");
    const connection = configRevisionPayloadSchema.parse(revision.payload).analyticsSources?.find((source) => source.id === batch.connectionId && source.enabled);
    if (!connection || ["source", "accountId", "resourceId", "timeZone"].some((key) => connection[key as keyof typeof connection] !== batch[key as keyof typeof batch])) throw new Error("REPORT_CONNECTION_MISMATCH");
    const run = await db.sourceCollectionRun.findUnique({ where: { id: runId } });
    if (!run || run.appId !== batch.appId || run.source !== batch.source || run.target !== batch.connectionId || run.status !== "running") throw new Error("REPORT_RUN_MISMATCH");
    const dedupeKey = jsonDigest({ ...batch } as unknown as JsonValue);
    const duplicate = await db.metricReportBatch.findUnique({ where: { dedupeKey } });
    if (duplicate) return { id: duplicate.id, duplicate: true };
    const row = await db.metricReportBatch.create({ data: {
      ...batch, periodStart: toDbDay(batch.periodStart), periodEnd: toDbDay(batch.periodEnd), processingDate: toDbDay(batch.processingDate),
      rows: batch.rows as unknown as Prisma.InputJsonArray, dedupeKey, runId,
    } });
    await db.auditLog.create({ data: { actorLogin: "system:metric-collection", action: "analytics.report.import", entityType: "MetricReportBatch", entityId: row.id,
      payload: { appId: batch.appId, configRevisionId: batch.configRevisionId, runId, sourceHash: batch.sourceHash, reportType: batch.reportType, periodStart: batch.periodStart, periodEnd: batch.periodEnd, rows: batch.rows.length } } });
    return { id: row.id, duplicate: false };
  }));
}

/** 최신 processingDate가 같은 날짜 partition을 통째로 대체한다. 예전 차원 행을 섞지 않는다. */
export async function metricReportPartitions(end: string, db: Prisma.TransactionClient = prisma, appId?: string) {
  const apps = await db.app.findMany({ where: { ...visibleAppWhere, ...(appId ? { id: appId } : {}) }, select: { id: true, configRevisions: { where: { status: "ACTIVE" }, orderBy: { revision: "desc" }, take: 1, select: { payload: true } } } });
  const connections = new Map(apps.map((app) => { const parsed = configRevisionPayloadSchema.safeParse(app.configRevisions[0]?.payload); return [app.id, parsed.success ? parsed.data.analyticsSources?.filter((source) => source.enabled) ?? [] : []]; }));
  const rows = await db.metricReportBatch.findMany({ where: {
    appId: { in: apps.map((app) => app.id) }, periodStart: { gte: toDbDay(shiftMetricDay(end, -89)), lte: toDbDay(end) },
  }, orderBy: [{ processingDate: "desc" }, { createdAt: "desc" }, { id: "desc" }] });
  const seen = new Set<string>();
  return rows.flatMap((batch) => {
    if (!connections.get(batch.appId)?.some((source) => source.source === batch.source && source.accountId === batch.accountId && source.resourceId === batch.resourceId && source.timeZone === batch.timeZone)) return [];
    const key = JSON.stringify([batch.appId, batch.source, batch.accountId, batch.resourceId, batch.reportType, dbDay(batch.periodStart), dbDay(batch.periodEnd), batch.grain, batch.timeZone]);
    if (seen.has(key)) return [];
    seen.add(key);
    const metrics = unifiedMetricRowSchema.array().parse(batch.rows);
    return [{ id: batch.id, appId: batch.appId, source: batch.source, accountId: batch.accountId, resourceId: batch.resourceId, reportType: batch.reportType,
      periodStart: dbDay(batch.periodStart), periodEnd: dbDay(batch.periodEnd), grain: batch.grain, timeZone: batch.timeZone,
      processingDate: dbDay(batch.processingDate), configRevisionId: batch.configRevisionId, sourceHash: batch.sourceHash, sourceUri: batch.sourceUri, runId: batch.runId, rows: metrics }];
  });
}
