import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { verifyStaticToken } from "@/lib/security";
import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { parseReportFile, playInstallRows } from "@/lib/analytics/report-files";
import { beginCollection, completeCollection } from "@/lib/insights/collection";
import { importMetricReport } from "@/lib/analytics/report-batches";
import { metricDayOf, parseMetricDay, toDbDay } from "@/lib/analytics/metric-day";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const inputSchema = z.object({ appId: z.string(), connectionId: z.string(), sourceUri: z.string(), sourceVersion: z.string().regex(/^\d{1,30}$/), fileBase64: z.string().max(45_000_000), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), processingDate: z.string().refine((value) => !!parseMetricDay(value)) }).strict();
/** API 없는 공식 파일의 인증된 가져오기. 임의 숫자 JSON 대신 원본과 해시·출처·generation을 남긴다. */
export async function POST(request: NextRequest) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let runId: string | undefined;
  try {
    const input = inputSchema.parse(await request.json());
    if (input.processingDate > metricDayOf(new Date())) throw new Error("FUTURE_PROCESSING_DATE");
    const app = await prisma.app.findFirst({ where: { id: input.appId, ...visibleAppWhere }, select: { id: true, playPackage: true, configRevisions: { where: { status: "ACTIVE" }, orderBy: { revision: "desc" }, take: 1 } } });
    const revision = app?.configRevisions[0], connection = revision && configRevisionPayloadSchema.parse(revision.payload).analyticsSources?.find((row) => row.id === input.connectionId && row.source === "play-reports" && row.enabled);
    if (!app?.playPackage || !revision || !connection || connection.resourceId !== app.playPackage) throw new Error("REPORT_CONFIG_MISMATCH");
    const path = `gs://${connection.accountId}/stats/installs/installs_${app.playPackage}_`;
    if (!input.sourceUri.startsWith(path) || !/^\d{6}_country\.csv$/.test(input.sourceUri.slice(path.length))) throw new Error("REPORT_SOURCE_MISMATCH");
    const buffer = Buffer.from(input.fileBase64, "base64"), hash = createHash("sha256").update(buffer).digest("hex");
    if (hash !== input.expectedSha256) throw new Error("REPORT_HASH_MISMATCH");
    const rows = playInstallRows(parseReportFile(buffer, ","), app.playPackage);
    const month = input.sourceUri.slice(path.length, path.length + 6);
    if (rows.some((row) => row.day.replaceAll("-", "").slice(0, 6) !== month || row.day > input.processingDate)) throw new Error("REPORT_DATE_MISMATCH");
    const run = await beginCollection("play-reports", connection.id, app.id); runId = run.id;
    const dates = [...new Set(rows.map((row) => row.day))].sort();
    for (const day of dates) await importMetricReport({ appId: app.id, configRevisionId: revision.id, connectionId: connection.id, source: connection.source, accountId: connection.accountId, resourceId: connection.resourceId, timeZone: connection.timeZone, reportType: "installs_country", sourceUri: input.sourceUri, sourceVersion: input.sourceVersion, sourceHash: hash, periodStart: day, periodEnd: day, grain: "daily", processingDate: input.processingDate, rows: rows.filter((row) => row.day === day).map((row) => row.row) }, run.id);
    await completeCollection(run.id, { status: dates.length ? "observed" : "not_landed", ...(dates.length ? { dataThrough: toDbDay(dates.at(-1)!) } : {}), coverage: { imported: true, sourceHash: hash, sourceUri: input.sourceUri, sourceVersion: input.sourceVersion, configRevisionId: revision.id, days: dates.length } });
    return NextResponse.json({ ok: true, runId, periodStart: dates[0] ?? null, periodEnd: dates.at(-1) ?? null, days: dates.length, sourceHash: hash });
  } catch { if (runId) await completeCollection(runId, { status: "failed", errorCode: "REPORT_IMPORT_FAILED" }); return NextResponse.json({ error: "invalid report or source binding", runId: runId ?? null }, { status: 400 }); }
}
