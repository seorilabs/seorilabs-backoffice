import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { jsonDigest, canonicalJson, type JsonValue } from "@/lib/control-plane/json";
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
    || batch.source === "android-vitals" && (uri.origin !== "https://playdeveloperreporting.googleapis.com" || !["crashRateMetricSet", "anrRateMetricSet"].some((set) => uri.pathname === `/v1beta1/apps/${batch.resourceId}/${set}`))
    || batch.source === "play-reports" && (uri.protocol !== "gs:" || uri.hostname !== batch.accountId || !uri.pathname.startsWith(`/stats/installs/installs_${batch.resourceId}_`) || !/\d{6}_country\.csv$/.test(uri.pathname))) throw new Error("REPORT_SOURCE_URI_MISMATCH");
  return retryPrismaConflict(() => prisma.$transaction(async (db) => {
    // 같은 활성 설정의 병렬 가져오기를 직렬화해 오래된 generation의 역전을 막는다.
    await db.$queryRaw`SELECT id FROM control_plane_config_revision WHERE id = ${batch.configRevisionId} FOR UPDATE`;
    const revision = await db.configRevision.findFirst({ where: { id: batch.configRevisionId, appId: batch.appId, status: "ACTIVE" } });
    if (!revision) throw new Error("REPORT_CONFIG_STALE");
    const connection = configRevisionPayloadSchema.parse(revision.payload).analyticsSources?.find((source) => source.id === batch.connectionId && source.enabled);
    if (!connection || ["source", "accountId", "resourceId", "timeZone"].some((key) => connection[key as keyof typeof connection] !== batch[key as keyof typeof batch])) throw new Error("REPORT_CONNECTION_MISMATCH");
    const run = await db.sourceCollectionRun.findUnique({ where: { id: runId } });
    if (!run || run.appId !== batch.appId || run.source !== batch.source || run.target !== batch.connectionId || run.status !== "running") throw new Error("REPORT_RUN_MISMATCH");
    if (batch.source === "play-reports") {
      if (!/^\d{1,30}$/.test(batch.sourceVersion)) throw new Error("PLAY_GENERATION_INVALID");
      // 실패·빈 실행·연결 이름 변경으로 URI별 최대 generation이 사라지지 않는다.
      const watermark = await db.$queryRaw<Array<{ version: string | null }>>`
        SELECT CAST(MAX(version) AS CHAR) AS version FROM (
          SELECT CAST(v.version AS DECIMAL(30,0)) AS version
          FROM source_collection_run r JOIN JSON_TABLE(r.coverage, '$.versions[*]'
            COLUMNS(uri VARCHAR(2048) PATH '$.uri', version VARCHAR(191) PATH '$.version')) v
          WHERE r.appId = ${batch.appId} AND r.source = 'play-reports' AND v.uri = ${batch.sourceUri}
            AND v.version REGEXP '^[0-9]{1,30}$'
          UNION ALL SELECT CAST(sourceVersion AS DECIMAL(30,0)) FROM metric_report_batch
          WHERE appId = ${batch.appId} AND source = 'play-reports' AND sourceUri = ${batch.sourceUri}
        ) history`;
      if (watermark[0]?.version && BigInt(watermark[0].version) > BigInt(batch.sourceVersion)) throw new Error("PLAY_GENERATION_STALE");
      const coverage = run.coverage as Prisma.InputJsonObject | null;
      const current = (coverage?.versions as Array<{ uri: string; version: string }> | undefined) ?? [];
      await db.sourceCollectionRun.update({ where: { id: runId }, data: { coverage: { ...coverage, versions: [...current.filter((one) => one.uri !== batch.sourceUri), { uri: batch.sourceUri, version: batch.sourceVersion }] } } });
    }
    const priorId = batch.source === "play-reports" ? await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM metric_report_batch WHERE appId = ${batch.appId} AND source = ${batch.source}
        AND accountId = ${batch.accountId} AND resourceId = ${batch.resourceId} AND reportType = ${batch.reportType}
        AND periodStart = ${toDbDay(batch.periodStart)} AND periodEnd = ${toDbDay(batch.periodEnd)}
        AND grain = ${batch.grain} AND timeZone = ${batch.timeZone}
      ORDER BY CAST(sourceVersion AS DECIMAL(30,0)) DESC, processingDate DESC, createdAt DESC, id DESC LIMIT 1` : null;
    const prior = priorId ? priorId.length ? await db.metricReportBatch.findUnique({ where: { id: priorId[0].id } }) : null : await db.metricReportBatch.findFirst({ where: { appId: batch.appId, source: batch.source, accountId: batch.accountId, resourceId: batch.resourceId, reportType: batch.reportType, periodStart: toDbDay(batch.periodStart), periodEnd: toDbDay(batch.periodEnd), grain: batch.grain, timeZone: batch.timeZone }, orderBy: [{ processingDate: "desc" }, { createdAt: "desc" }, { id: "desc" }] });
    if (batch.source === "play-reports" && prior && BigInt(batch.sourceVersion) < BigInt(prior.sourceVersion)) throw new Error("PLAY_GENERATION_STALE");
    if (prior && normalizedRowsHash(prior.rows as unknown as MetricReportBatchInput["rows"]) === normalizedRowsHash(batch.rows)) return { id: prior.id, duplicate: true };
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
export async function* metricReportPartitions(end: string, db: Prisma.TransactionClient = prisma, appId?: string) {
  const apps = await db.app.findMany({ where: visibleAppWhere, select: { id: true, configRevisions: { where: { status: "ACTIVE" }, orderBy: { revision: "desc" }, take: 1, select: { payload: true } } } });
  const connections = new Map(apps.map((app) => { const parsed = configRevisionPayloadSchema.safeParse(app.configRevisions[0]?.payload); return [app.id, parsed.success ? parsed.data.analyticsSources?.filter((source) => source.enabled) ?? [] : []]; }));
  const admobOwners = new Map<string, Set<string>>();
  for (const [app, sources] of connections) for (const source of sources) if (source.source === "admob") { const owners = admobOwners.get(source.resourceId) ?? new Set<string>(); owners.add(app); admobOwners.set(source.resourceId, owners); }
  for (const [app, sources] of connections) connections.set(app, sources.filter((source) => source.source !== "admob" || admobOwners.get(source.resourceId)?.size === 1));
  if (!apps.length) return;
  // JSON 원천은 최신 partition만 읽는다. 과거 처리본 수에 비례해 메모리를 쓰지 않는다.
  const latest = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY appId, source, accountId, resourceId, reportType, periodStart, periodEnd, grain, timeZone
        ORDER BY CASE WHEN source = 'play-reports' THEN CAST(sourceVersion AS DECIMAL(30,0)) ELSE 0 END DESC,
          processingDate DESC, createdAt DESC, id DESC
      ) AS position FROM metric_report_batch
      WHERE appId IN (${Prisma.join(apps.map((app) => app.id))})
        AND periodStart >= ${toDbDay(shiftMetricDay(end, -89))} AND periodStart <= ${toDbDay(end)}
    ) ranked WHERE position = 1
  `);
  const seen = new Set<string>();
  for (let offset = 0; offset < latest.length; offset += 32) {
    const rows = await db.metricReportBatch.findMany({ where: { ...(appId ? { appId } : {}), id: { in: latest.slice(offset, offset + 32).map((row) => row.id) } } });
    for (const batch of rows) {
      if (!connections.get(batch.appId)?.some((source) => source.source === batch.source && source.accountId === batch.accountId && source.resourceId === batch.resourceId && source.timeZone === batch.timeZone)) continue;
      const key = JSON.stringify([batch.appId, batch.source, batch.accountId, batch.resourceId, batch.reportType, dbDay(batch.periodStart), dbDay(batch.periodEnd), batch.grain, batch.timeZone]);
      if (seen.has(key)) continue;
      seen.add(key);
      const metrics = unifiedMetricRowSchema.array().parse(batch.rows);
      yield { id: batch.id, appId: batch.appId, source: batch.source, accountId: batch.accountId, resourceId: batch.resourceId, reportType: batch.reportType,
        periodStart: dbDay(batch.periodStart), periodEnd: dbDay(batch.periodEnd), grain: batch.grain, timeZone: batch.timeZone,
        processingDate: dbDay(batch.processingDate), configRevisionId: batch.configRevisionId, sourceHash: batch.sourceHash, sourceUri: batch.sourceUri, runId: batch.runId, rows: metrics };
    }
  }
}

/** 일별 값·차원·완성 상태만 비교한다. 파일 재생성·수집일 변경은 중복 자료다. */
export function normalizedRowsHash(rows: MetricReportBatchInput["rows"]) {
  return jsonDigest([...rows].sort((a, b) => canonicalJson(a as unknown as JsonValue).localeCompare(canonicalJson(b as unknown as JsonValue))) as unknown as JsonValue);
}
