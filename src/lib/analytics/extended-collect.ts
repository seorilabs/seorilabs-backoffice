import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { beginCollection, completeCollection, collectionErrorCode } from "@/lib/insights/collection";
import { metricDayOf, shiftMetricDay, toDbDay } from "./metric-day";
import { importMetricReport } from "./report-batches";
import { appleReportCatalog, appleInstances, applePages, appleSegmentVersion, readAppleInstance, verifyAppleAppIdentity } from "./providers/apple-analytics";
import { readAdmob } from "./providers/admob";
import { readVitals } from "./providers/android-vitals";
import { env } from "@/lib/env";
import { readPlayInstallReport } from "./providers/play-reports";
import type { DatedMetricRow } from "./report-files";
import { completedInstance, recordInstanceCompletion } from "./instance-completion";
import type { AnalyticsConnection } from "./source-contract";

function groupDays(rows: DatedMetricRow[], start: string, end: string) {
  const groups = new Map<string, DatedMetricRow["row"][]>();
  for (const cell of rows) if (cell.day >= start && cell.day <= end) groups.set(cell.day, [...(groups.get(cell.day) ?? []), cell.row]);
  return groups;
}
/** 계정/앱/설정을 실행에 고정한다. 비활성 연결은 조회하지 않는다. 최초 90일, 재실행은 원천 버전으로 중복을 제거한다. */
const defaultPorts = { appleReportCatalog, appleInstances, applePages, readAppleInstance, verifyAppleAppIdentity, readPlayInstallReport, readAdmob, readVitals };
export async function collectExtendedMetrics(now = new Date(), appId?: string, ports: typeof defaultPorts = defaultPorts) {
  const end = shiftMetricDay(metricDayOf(now), -1), start = shiftMetricDay(end, -89);
  const apps = await prisma.app.findMany({ where: { ...visibleAppWhere, ...(appId ? { id: appId } : {}) }, select: { id: true, iosBundle: true, playPackage: true, configRevisions: { where: { status: "ACTIVE" }, orderBy: { revision: "desc" }, take: 1 } } });
  const results: Array<{ appId: string; connectionId: string; runId: string; status: string; batches: number; periodStart: string; periodEnd: string }> = [];
  for (const app of apps) {
    const revision = app.configRevisions[0];
    const config = revision && configRevisionPayloadSchema.safeParse(revision.payload);
    if (!config?.success) continue;
    for (const connection of config.data.analyticsSources ?? []) {
      const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: connection.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const end = shiftMetricDay(localDay, -1), start = shiftMetricDay(end, -89);
      if (!connection.enabled) continue;
      const run = await beginCollection(connection.source, connection.id, app.id);
      await prisma.sourceCollectionRun.update({ where: { id: run.id }, data: { coverage: collectionScope(connection, revision.id, start, end, 0, new Map()) } });
      let batches = 0, latest: string | undefined;
      const versions = new Map<string, string>();
      const failures: Array<{ reportType: string; instanceId: string; errorCode: string }> = [];
      const save = async (rows: DatedMetricRow[], reportType: string, sourceVersion: string, sourceHash: string, sourceUri: string, processingDate: string) => {
        for (const [day, metrics] of groupDays(rows, start, end)) {
          const result = await importMetricReport({ appId: app.id, configRevisionId: revision.id, connectionId: connection.id, source: connection.source,
            accountId: connection.accountId, resourceId: connection.resourceId, timeZone: connection.timeZone,
            reportType, sourceVersion, sourceHash, sourceUri, processingDate, grain: "daily", periodStart: day, periodEnd: day, rows: metrics }, run.id);
          if (!result.duplicate) batches++;
          if (!latest || day > latest) latest = day;
        }
        versions.set(sourceUri, sourceVersion);
      };
      try {
        if (connection.source === "apple-analytics") {
          if (!app.iosBundle) throw new Error("APPLE_APP_IDENTITY_MISSING");
          if (process.env.APP_STORE_CONNECT_ISSUER_ID !== connection.accountId) throw new Error("APPLE_ACCOUNT_IDENTITY_MISMATCH");
          const catalog = await ports.appleReportCatalog(connection.resourceId, app.iosBundle);
          for (const report of catalog) {
            for (const instance of await ports.appleInstances(report.id)) {
              try {
              const processingDate = String(instance.attributes!.processingDate);
              if (processingDate < start) continue;
              const sourceUri = `https://api.appstoreconnect.apple.com/v1/analyticsReportInstances/${encodeURIComponent(instance.id)}`;
              const segments = await ports.applePages(`/v1/analyticsReportInstances/${encodeURIComponent(instance.id)}/segments?limit=200`);
              const descriptor = appleSegmentVersion(segments);
              // 전 segment의 checksum이 있을 때에만 재다운로드를 생략한다. URL 만료는 버전 변경이 아니다.
              const sourceVersion = `${instance.id}:${descriptor}`;
              const cached = segments.length && segments.every((one) => typeof one.attributes?.checksum === "string")
                ? await completedInstance(app.id, connection, sourceUri, sourceVersion, start, end) : null;
              if (cached) { if (cached.through && cached.through >= start && cached.through <= end && (!latest || cached.through > latest)) latest = cached.through; continue; }
              const parsed = await ports.readAppleInstance({ appId: connection.resourceId, reportType: String(report.attributes!.name), processingDate, segments });
              await save(parsed.rows, String(report.attributes!.name), sourceVersion, parsed.sourceHash, sourceUri, processingDate);
              const days = parsed.rows.map((one) => one.day).sort(), saved = days.filter((day) => day >= start && day <= end);
              await recordInstanceCompletion(run.id, { uri: sourceUri, version: sourceVersion, savedStart: start, savedEnd: end, maxDay: days.at(-1) ?? null, through: saved.at(-1) ?? null });
              } catch (error) {
                const message = error instanceof Error ? error.message : "";
                if (/401|403|PERMISSION|IDENTITY/.test(message)) throw error;
                failures.push({ reportType: String(report.attributes!.name), instanceId: instance.id, errorCode: /^(APPLE|REPORT)_[A-Z0-9_]+$/.test(message) ? message : collectionErrorCode(error) });
              }
            }
          }
        } else if (connection.source === "android-vitals") {
          if (!app.playPackage || connection.resourceId !== app.playPackage) throw new Error("PLAY_VITALS_APP_IDENTITY_MISMATCH");
          if (!env.googlePlayServiceAccountJson()) throw new Error("PLAY_VITALS_PERMISSION_REQUIRED");
          const identity = JSON.parse(env.googlePlayServiceAccountJson());
          if (identity.client_id !== connection.accountId) throw new Error("PLAY_VITALS_ACCOUNT_IDENTITY_MISMATCH");
          for (const report of await ports.readVitals({ packageName: app.playPackage, start, end })) {
            const hash = createHash("sha256").update(JSON.stringify(report.raw)).digest("hex");
            await save(report.rows, report.reportType, hash, hash, report.sourceUri, localDay);
          }
        } else if (connection.source === "play-reports") {
          if (!app.playPackage || connection.resourceId !== app.playPackage) throw new Error("PLAY_APP_IDENTITY_MISMATCH");
          const months = new Set([start.slice(0, 7), end.slice(0, 7)]);
          for (let date = start; date <= end; date = shiftMetricDay(date, 1)) months.add(date.slice(0, 7));
          for (const month of [...months].sort()) {
            try {
              const report = await ports.readPlayInstallReport(connection.accountId, app.playPackage, month.replace("-", ""));
              await save(report.rows, "installs_country", report.sourceVersion, report.sourceHash, report.sourceUri, metricDayOf(now));
            } catch (error) { if ((error as { code?: number }).code !== 404) throw error; }
          }
        } else {
          const ads = config.data.ads, platform = ads?.platforms.find((one) => one.admobAppId === connection.resourceId);
          if (!ads || ads.publisherId !== connection.accountId || !platform || platform.applicationId !== (platform.platform === "android" ? app.playPackage : app.iosBundle)) throw new Error("ADMOB_APP_IDENTITY_MISMATCH");
          const active = await prisma.configRevision.findMany({ where: { status: "ACTIVE", appId: { not: app.id } }, select: { payload: true } });
          if (active.some((row) => { const other = configRevisionPayloadSchema.safeParse(row.payload); return other.success && other.data.analyticsSources?.some((one) => one.enabled && one.source === "admob" && one.resourceId === connection.resourceId); })) throw new Error("ADMOB_RESOURCE_DUPLICATE");
          const apple = config.data.analyticsSources?.find((one) => one.source === "apple-analytics");
          if (platform.platform === "ios") {
            if (!apple || !app.iosBundle || process.env.APP_STORE_CONNECT_ISSUER_ID !== apple.accountId) throw new Error("ADMOB_APP_IDENTITY_MISSING");
            await ports.verifyAppleAppIdentity(apple.resourceId, app.iosBundle);
          }
          const report = await ports.readAdmob({ applicationId: platform.platform === "android" ? platform.applicationId : config.data.analyticsSources?.find((one) => one.source === "apple-analytics")?.resourceId, accountId: connection.accountId, appId: connection.resourceId, timeZone: connection.timeZone, start, end, processingDate: localDay });
          const hash = createHash("sha256").update(JSON.stringify(report.raw)).digest("hex");
          await save(report.rows, "network_country_format_ad_unit", hash, hash, `https://admob.googleapis.com/v1/accounts/${connection.accountId}/networkReport`, metricDayOf(now));
        }
        const status = failures.length ? latest ? "partial" : failures.every((one) => one.errorCode === "APPLE_SEGMENTS_NOT_LANDED") ? "not_landed" : "failed" : latest ? "observed" : "not_landed";
        await completeCollection(run.id, { status, ...(latest ? { dataThrough: toDbDay(latest) } : {}), coverage: { ...collectionScope(connection, revision.id, start, end, batches, versions), reportFailures: failures.slice(0, 200), reportFailureCount: failures.length } });
        results.push({ appId: app.id, connectionId: connection.id, runId: run.id, status, batches, periodStart: start, periodEnd: end });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const code = /^(APPLE|ADMOB|PLAY|REPORT)_[A-Z0-9_]+$/.test(message) ? message : collectionErrorCode(error);
        const status = latest ? "partial" : /PERMISSION|INITIAL_REPORT|IDENTITY|RESOURCE_DUPLICATE|Missing required env|OAUTH|_HTTP_40[13]/.test(message) || collectionErrorCode(error) === "SOURCE_PERMISSION_REQUIRED" ? "needs_input" : "failed";
        await completeCollection(run.id, { status, errorCode: code, ...(latest ? { dataThrough: toDbDay(latest) } : {}), coverage: { ...collectionScope(connection, revision.id, start, end, batches, versions), reportFailures: failures.slice(0, 200), reportFailureCount: failures.length } });
        results.push({ appId: app.id, connectionId: connection.id, runId: run.id, status, batches, periodStart: start, periodEnd: end });
      }
    }
  }
  return { periodStart: start, periodEnd: end, results };
}
function collectionScope(connection: AnalyticsConnection, configRevisionId: string, start: string, end: string, batches: number, versions: Map<string, string>) {
  return { versions: [...versions].map(([uri, version]) => ({ uri, version })), connectionId: connection.id, accountId: connection.accountId, resourceId: connection.resourceId, credentialId: connection.credentialId, timeZone: connection.timeZone, configRevisionId, start, end, batches };
}
