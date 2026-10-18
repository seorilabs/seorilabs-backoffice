import { Prisma } from "@prisma/client";
import { retryPrismaConflict } from "@/lib/prisma-conflict";
import { prisma } from "@/lib/prisma";
import { collectHighlightData, dailyReportContext, metricHighlightDedupeKey } from "@/lib/core/metric-highlights";
import { assembleOrgReportDocument, orgTrendSeries, saveOrgReport } from "@/lib/core/org-report";
import { parseOrgReportDocument, type OrgReportDocument } from "@/lib/core/org-report-schema";
import { metricSourceInventory } from "@/lib/analytics/source-inventory";
import { metricDayStart, shiftMetricDay, lastElapsedMetricDay, toDbDay } from "@/lib/analytics/metric-day";
import { dailyReportSchedule } from "./daily-contract";
import { reportConclusions, reportFactsHash, renderDailyEdition, reportCorrectionDiff } from "./daily-presentation";
import { metricNarrative } from "@/lib/core/metric-narrative";
import { collectFinanceCosts, financeMonth } from "@/lib/core/finance-costs";
import { orgReportUrl } from "@/lib/core/org-report-link";
import { enqueueNotification, requeueNotification } from "@/lib/notifications/outbox";
import { discordDestinations } from "@/lib/notifications/destinations";
import { SEORI_SENDER } from "@/lib/notifications/sender";
import { reportCohorts } from "./cohorts";

async function freezeDailyReport(now: Date, refDate: string, db: Prisma.TransactionClient) {
  const schedule = dailyReportSchedule(metricDayStart(shiftMetricDay(refDate, 1)));
    const data = await collectHighlightData(now, refDate, db);
    const sources = await metricSourceInventory(refDate, db);
    const trend = await orgTrendSeries(refDate, 28, db);
    const cohorts = await reportCohorts(refDate, db);
    const { context } = await dailyReportContext(refDate, db);
    const doc = assembleOrgReportDocument({ data, narrative: null, costs: null, origin: "published", generatedAt: now });
    doc.edition = {
      cutoffAt: schedule.cutoffAt.toISOString(), dueAt: schedule.dueAt.toISOString(), frozenAt: now.toISOString(),
      inputHash: "", sources, trend, cohorts, context, changes: [], conclusions: [...context.map((line) => line.replace(/^- /, "")), ...reportConclusions(doc)].slice(0, 3), actions: [],
    };
    doc.edition.inputHash = reportFactsHash(doc);
    return { data, doc };
}

/** 외부 호출 전에 일관된 DB snapshot을 저장한다. 재시도는 같은 준비본을 유지한다. */
export async function prepareDailyReport(now = new Date(), refDate?: string) {
  const schedule = dailyReportSchedule(refDate ? metricDayStart(shiftMetricDay(refDate, 1)) : now), date = toDbDay(schedule.refDate);
  if (now < schedule.cutoffAt) throw new Error("REPORT_BEFORE_CUTOFF");
  const existing = await prisma.orgReportPreparation.findUnique({ where: { date } });
  if (existing) return { preparationId: existing.id, refDate: schedule.refDate, reused: true };
  const prepared = await retryPrismaConflict(() => prisma.$transaction(async (db) => {
    const raced = await db.orgReportPreparation.findUnique({ where: { date } });
    if (raced) return { row: raced, doc: null, data: null };
    const { data, doc } = await freezeDailyReport(now, schedule.refDate, db);
    const row = await db.orgReportPreparation.create({ data: { date, document: doc as unknown as Prisma.InputJsonObject, preparedAt: now } });
    return { row, doc, data };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 }));
  if (!prepared.doc || !prepared.data) return { preparationId: prepared.row.id, refDate: schedule.refDate, reused: true };
  // 11시에는 이 작업을 기다리지 않는다. 실패하면 저장된 수치·고정 문장으로 발행한다.
  const [narrative, costs, attachment] = await Promise.allSettled([
    metricNarrative(prepared.data), collectFinanceCosts(now), dailyReportImage(prepared.doc),
  ]);
  const doc = prepared.doc;
  if (narrative.status === "fulfilled") {
    doc.narrative = narrative.value.text;
    doc.narrativeMeta = { fallback: narrative.value.fallback, provider: narrative.value.provider, model: narrative.value.model, promptVersion: narrative.value.promptVersion };
  }
  if (costs.status === "fulfilled") doc.costs = { month: financeMonth(now).month, ...costs.value };
  await prisma.orgReportPreparation.updateMany({ where: { id: prepared.row.id, publishedVersion: null }, data: {
    enrichment: { narrative: doc.narrative, narrativeMeta: doc.narrativeMeta ?? null, costs: doc.costs } as unknown as Prisma.InputJsonObject,
    ...(attachment.status === "fulfilled" ? { attachment: attachment.value as unknown as Prisma.InputJsonObject } : {}),
    enrichedAt: new Date(),
  } });
  return { preparationId: prepared.row.id, refDate: schedule.refDate, reused: false };
}

export async function dailyReportImage(doc: OrgReportDocument) {
  const { reportChartSvg } = await import("./discord-chart");
  const sharp = (await import("sharp")).default;
  const points = doc.edition?.trend ?? [];
  const charts = [
    { title: `활성·신규 사용자 · ${doc.refDate}`, unit: "명", source: "GA4 · 앱 사이 사용자 중복 포함 · 발행 입력 고정", series: [
      { label: "활성 합계", color: "#2563eb", values: points.map((point) => point.ga4Dau) },
      { label: "신규 합계", color: "#059669", values: points.map((point) => point.ga4NewUsers) },
    ] },
    { title: "광고 추정 수익·결제 거래액", unit: "KRW", source: "앱인토스 · 정산 후 순수익과 구분 · 발행 입력 고정", series: [
      { label: "광고 추정 수익", color: "#d97706", values: points.map((point) => point.consoleIaaKrw) },
      { label: "결제 거래액", color: "#7c3aed", values: points.map((point) => point.consoleIapTrxKrw) },
    ] },
  ];
  const buffers = await Promise.all(charts.map((chart) => sharp(Buffer.from(reportChartSvg({ ...chart, days: points.map((point) => point.date) }))).png().toBuffer()));
  const bytes = await sharp({ create: { width: 960, height: 1020, channels: 4, background: "#fff" } })
    .composite(buffers.map((input, index) => ({ input, left: 0, top: index * 510 }))).png().toBuffer();
  return { filename: "daily-report.png", contentType: "image/png", base64: bytes.toString("base64") };
}

/** 발행은 저장된 준비본과 outbox만 사용한다. 문서·버전·알림·발행 표시는 한 transaction이다. */
export async function publishDailyReport(now = new Date(), refDate?: string) {
  const schedule = dailyReportSchedule(refDate ? metricDayStart(shiftMetricDay(refDate, 1)) : now);
  if (now < schedule.dueAt) throw new Error("REPORT_BEFORE_PUBLICATION");
  return retryPrismaConflict(() => prisma.$transaction(async (db) => {
    let preparation = await db.orgReportPreparation.findUnique({ where: { date: toDbDay(schedule.refDate) } });
    if (!preparation) {
      // 준비 작업 실패 시에도 외부 API·해설을 호출하지 않는다. 실제 고정 시각의 지연을 문서에 남긴다.
      const { doc } = await freezeDailyReport(now, schedule.refDate, db);
      preparation = await db.orgReportPreparation.create({ data: { date: toDbDay(schedule.refDate), document: doc as unknown as Prisma.InputJsonObject, preparedAt: now } });
    }
    if (preparation.publishedVersion !== null) return { preparationId: preparation.id, refDate: schedule.refDate, version: preparation.publishedVersion, reused: true };
    const claim = await db.orgReportPreparation.updateMany({ where: { id: preparation.id, publishedVersion: null }, data: { publishedVersion: 0 } });
    if (!claim.count) {
      const current = await db.orgReportPreparation.findUniqueOrThrow({ where: { id: preparation.id } });
      return { preparationId: current.id, refDate: schedule.refDate, version: current.publishedVersion, reused: true };
    }
    const doc = parseOrgReportDocument(preparation.document);
    if (!doc?.edition) throw new Error("REPORT_PREPARATION_INVALID");
    const enriched = preparation.enrichment as { narrative?: string; narrativeMeta?: OrgReportDocument["narrativeMeta"]; costs?: OrgReportDocument["costs"] } | null;
    if (enriched) { doc.narrative = enriched.narrative ?? null; doc.narrativeMeta = enriched.narrativeMeta; doc.costs = enriched.costs ?? null; }
    doc.generatedAt = now.toISOString();
    doc.published = { factsHash: doc.edition.inputHash, dedupeKey: metricHighlightDedupeKey(doc.refDate), publishedAt: now.toISOString(),
      observed: doc.edition.sources.filter((source) => ["observed", "empty"].includes(source.state)).length,
      expected: doc.edition.sources.filter((source) => source.state !== "not_applicable").length, corrections: 0 };
    const { version } = await saveOrgReport(doc, db);
    const url = orgReportUrl(doc.refDate, version);
    const eventId = await enqueueNotification({ dedupeKey: doc.published.dedupeKey, kind: "OPERATIONAL_EVENT", occurredAt: now,
      payload: { text: renderDailyEdition(doc, version, url), refDate: doc.refDate, reportVersion: version,
        report: { category: "change", reason: "SCHEDULED_DAILY_REPORT" }, sender: SEORI_SENDER, editable: true,
        ...(preparation.attachment ? { attachment: preparation.attachment as Prisma.InputJsonObject } : {}),
        ...(url ? { components: [{ type: 1, components: [{ type: 2, style: 5, label: `전체 보고서 v${version}`, url }] }] } : {}),
      }, destinations: discordDestinations(["app-ops"]) }, db);
    await requeueNotification(eventId, db);
    await db.orgReportPreparation.update({ where: { id: preparation.id }, data: { publishedVersion: version } });
    return { preparationId: preparation.id, refDate: doc.refDate, version, eventId, reused: false };
  }, { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }));
}

/** 늦은 자료는 새 버전에 보존하고 같은 outbox 메시지의 숫자·그림·링크를 함께 고친다. */
export async function correctDailyReport(now = new Date(), refDate = shiftMetricDay(lastElapsedMetricDay(now), -1)) {
  const frozen = await prisma.$transaction((db) => freezeDailyReport(now, refDate, db), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000,
  });
  const attachment = await dailyReportImage(frozen.doc).catch(() => null);
  return prisma.$transaction(async (db) => {
    // 동일 날짜의 정정을 직렬화한다. 이전 버전 확인과 outbox 갱신을 분리하지 않는다.
    await db.$queryRaw`SELECT id FROM org_report_daily WHERE date = ${toDbDay(refDate)} FOR UPDATE`;
    const latest = await db.orgReportDaily.findUnique({ where: { date: toDbDay(refDate) } });
    const previous = latest ? parseOrgReportDocument(latest.report) : null;
    if (!previous?.published) return { day: refDate, action: "none", version: null, requeued: 0 };
    const doc = frozen.doc;
    if (previous.edition && previous.edition.frozenAt >= doc.edition!.frozenAt) return { day: refDate, action: "none", version: latest!.version, requeued: 0 };
    if (previous.published.factsHash === doc.edition!.inputHash) return { day: refDate, action: "none", version: latest!.version, requeued: 0 };
    doc.costs = previous.costs;
    doc.edition!.replacesVersion = latest!.version;
    doc.edition!.changes = reportCorrectionDiff(previous, doc);
    // 앞선 수치에서 만든 해설은 새 수치의 원인 설명으로 재사용하지 않는다.
    doc.narrative = null;
    doc.published = { ...previous.published, factsHash: doc.edition!.inputHash, corrections: previous.published.corrections + 1 };
    const { version } = await saveOrgReport(doc, db);
    const url = orgReportUrl(refDate, version);
    const eventId = await enqueueNotification({ dedupeKey: doc.published.dedupeKey, kind: "OPERATIONAL_EVENT", occurredAt: now,
      payload: { text: renderDailyEdition(doc, version, url), reportVersion: version, refDate,
        report: { category: "change", reason: "DAILY_REPORT_CORRECTION" }, sender: SEORI_SENDER, editable: true,
        ...(attachment ? { attachment: attachment as unknown as Prisma.InputJsonObject } : {}),
        ...(url ? { components: [{ type: 1, components: [{ type: 2, style: 5, label: `정정 보고서 v${version}`, url }] }] } : {}),
      }, destinations: discordDestinations(["app-ops"]) }, db);
    const requeued = await requeueNotification(eventId, db);
    return { day: refDate, action: "corrected", version, requeued };
  }, { timeout: 30_000 });
}
