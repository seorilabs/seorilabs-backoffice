import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { beginCollection, completeCollection, collectionErrorCode } from "@/lib/insights/collection";
import { metricDayOf, shiftMetricDay, toDbDay } from "./metric-day";
import { importMetricReport } from "./report-batches";
import { appleReportCatalog, appleInstances, applePages, appleSegmentVersion, readAppleInstance } from "./providers/apple-analytics";
import { readAdmob } from "./providers/admob";
import { readPlayInstallReport } from "./providers/play-reports";
import type { DatedMetricRow } from "./report-files";
import type { AnalyticsConnection } from "./source-contract";

function groupDays(rows: DatedMetricRow[], start: string, end: string) {
  const groups = new Map<string, DatedMetricRow["row"][]>();
  for (const cell of rows) if (cell.day >= start && cell.day <= end) groups.set(cell.day, [...(groups.get(cell.day) ?? []), cell.row]);
  return groups;
}
/** 계정/앱/설정을 실행에 고정한다. 비활성 연결은 조회하지 않는다. 최초 90일, 재실행은 원천 버전으로 중복을 제거한다. */
export async function collectExtendedMetrics(now = new Date(), appId?: string) {
  const end = shiftMetricDay(metricDayOf(now), -1), start = shiftMetricDay(end, -89);
  const apps = await prisma.app.findMany({ where: { ...visibleAppWhere, ...(appId ? { id: appId } : {}) }, select: { id: true, iosBundle: true, playPackage: true, configRevisions: { where: { status: "ACTIVE" }, orderBy: { revision: "desc" }, take: 1 } } });
  const results: Array<{ appId: string; connectionId: string; runId: string; status: string; batches: number }> = [];
  for (const app of apps) {
    const revision = app.configRevisions[0];
    const config = revision && configRevisionPayloadSchema.safeParse(revision.payload);
    if (!config?.success) continue;
    for (const connection of config.data.analyticsSources ?? []) {
      if (!connection.enabled) continue;
      const run = await beginCollection(connection.source, connection.id, app.id);
      let batches = 0, latest: string | undefined;
      const save = async (rows: DatedMetricRow[], reportType: string, sourceVersion: string, sourceHash: string, sourceUri: string, processingDate: string) => {
        for (const [day, metrics] of groupDays(rows, start, end)) {
          const result = await importMetricReport({ appId: app.id, configRevisionId: revision.id, connectionId: connection.id, source: connection.source,
            accountId: connection.accountId, resourceId: connection.resourceId, timeZone: connection.timeZone,
            reportType, sourceVersion, sourceHash, sourceUri, processingDate, grain: "daily", periodStart: day, periodEnd: day, rows: metrics }, run.id);
          if (!result.duplicate) batches++;
          if (!latest || day > latest) latest = day;
        }
      };
      try {
        if (connection.source === "apple-analytics") {
          if (!app.iosBundle) throw new Error("APPLE_APP_IDENTITY_MISSING");
          if (process.env.APP_STORE_CONNECT_ISSUER_ID !== connection.accountId) throw new Error("APPLE_ACCOUNT_IDENTITY_MISMATCH");
          const catalog = await appleReportCatalog(connection.resourceId, app.iosBundle);
          for (const report of catalog) {
            for (const instance of await appleInstances(report.id)) {
              const processingDate = String(instance.attributes!.processingDate);
              if (processingDate < start) continue;
              const sourceUri = `https://api.appstoreconnect.apple.com/v1/analyticsReportInstances/${encodeURIComponent(instance.id)}`;
              const segments = await applePages(`/v1/analyticsReportInstances/${encodeURIComponent(instance.id)}/segments?limit=200`);
              const descriptor = appleSegmentVersion(segments);
              // 전 segment의 checksum이 있을 때에만 재다운로드를 생략한다. URL 만료는 버전 변경이 아니다.
              const sourceVersion = `${instance.id}:${descriptor}`;
              const cached = segments.length && segments.every((one) => typeof one.attributes?.checksum === "string")
                ? await prisma.metricReportBatch.findFirst({ where: { appId: app.id, configRevisionId: revision.id, connectionId: connection.id, sourceVersion, sourceUri }, orderBy: { periodEnd: "desc" } }) : null;
              const completeCachedRun = cached && await prisma.sourceCollectionRun.findUnique({ where: { id: cached.runId }, select: { status: true, completedAt: true } });
              if (cached && completeCachedRun?.status === "observed" && completeCachedRun.completedAt) { const through = cached.periodEnd.toISOString().slice(0, 10); if (!latest || through > latest) latest = through; continue; }
              const parsed = await readAppleInstance({ appId: connection.resourceId, reportType: String(report.attributes!.name), processingDate, segments });
              await save(parsed.rows, String(report.attributes!.name), sourceVersion, parsed.sourceHash, sourceUri, processingDate);
            }
          }
        } else if (connection.source === "play-reports") {
          if (!app.playPackage || connection.resourceId !== app.playPackage) throw new Error("PLAY_APP_IDENTITY_MISMATCH");
          const months = new Set([start.slice(0, 7), end.slice(0, 7)]);
          for (let date = start; date <= end; date = shiftMetricDay(date, 1)) months.add(date.slice(0, 7));
          for (const month of months) {
            try {
              const report = await readPlayInstallReport(connection.accountId, app.playPackage, month.replace("-", ""));
              await save(report.rows, "installs_country", report.sourceVersion, report.sourceHash, report.sourceUri, metricDayOf(now));
            } catch (error) { if ((error as { code?: number }).code !== 404) throw error; }
          }
        } else {
          const report = await readAdmob({ accountId: connection.accountId, appId: connection.resourceId, timeZone: connection.timeZone, start, end, processingDate: metricDayOf(now) });
          const hash = createHash("sha256").update(JSON.stringify(report.raw)).digest("hex");
          await save(report.rows, "network_country_format_ad_unit", hash, hash, `https://admob.googleapis.com/v1/accounts/${connection.accountId}/networkReport`, metricDayOf(now));
        }
        const status = latest ? "observed" : "not_landed";
        await completeCollection(run.id, { status, ...(latest ? { dataThrough: toDbDay(latest) } : {}), coverage: collectionScope(connection, revision.id, start, end, batches) });
        results.push({ appId: app.id, connectionId: connection.id, runId: run.id, status, batches });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const code = /^(APPLE|ADMOB|PLAY|REPORT)_[A-Z0-9_]+$/.test(message) ? message : collectionErrorCode(error);
        const status = latest ? "partial" : /PERMISSION|INITIAL_REPORT|IDENTITY|Missing required env|OAUTH|_HTTP_40[13]/.test(message) || collectionErrorCode(error) === "SOURCE_PERMISSION_REQUIRED" ? "needs_input" : "failed";
        await completeCollection(run.id, { status, errorCode: code, ...(latest ? { dataThrough: toDbDay(latest) } : {}), coverage: collectionScope(connection, revision.id, start, end, batches) });
        results.push({ appId: app.id, connectionId: connection.id, runId: run.id, status, batches });
      }
    }
  }
  return { periodStart: start, periodEnd: end, results };
}
function collectionScope(connection: AnalyticsConnection, configRevisionId: string, start: string, end: string, batches: number) {
  return { connectionId: connection.id, accountId: connection.accountId, resourceId: connection.resourceId, credentialId: connection.credentialId, configRevisionId, start, end, batches };
}
