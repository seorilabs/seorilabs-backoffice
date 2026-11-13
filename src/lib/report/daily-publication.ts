import { metricIssueReportActions } from "@/lib/metric-issues/report-actions";
import { Prisma } from "@prisma/client";
import { retryPrismaConflict } from "@/lib/prisma-conflict";
import { prisma } from "@/lib/prisma";
import { collectHighlightData, dailyReportContext, metricHighlightDedupeKey } from "@/lib/core/metric-highlights";
import { assembleOrgReportDocument, orgTrendSeries, saveOrgReport } from "@/lib/core/org-report";
import { parseOrgReportDocument, orgReportDocumentSchema, type OrgReportDocument } from "@/lib/core/org-report-schema";
import { metricSourceInventory } from "@/lib/analytics/source-inventory";
import { dbDay, metricDayStart, shiftMetricDay, lastElapsedMetricDay, toDbDay } from "@/lib/analytics/metric-day";
import { dailyReportSchedule } from "./daily-contract";
import { reportConclusions, reportFactsHash, sameReportFacts, renderDailyEdition, reportCorrectionDiff,financialReportFacts,renderFinancialEdition } from "./daily-presentation";
import { metricNarrative } from "@/lib/core/metric-narrative";
import { financeMonth } from "@/lib/core/finance-costs";
import { orgReportUrl } from "@/lib/core/org-report-link";
import { enqueueNotification, requeueNotification } from "@/lib/notifications/outbox";
import { notificationDestinations } from "@/lib/notifications/destinations";
import { SEORI_SENDER } from "@/lib/notifications/sender";
import { reportCohorts } from "./cohorts";
import { providerMetricSeries } from "@/lib/analytics/report-query";
import { metricDayWindow } from "@/lib/analytics/metric-day";

async function freezeDailyReport(now: Date, refDate: string, db: Prisma.TransactionClient) {
  const schedule = dailyReportSchedule(metricDayStart(shiftMetricDay(refDate, 1)));
    const data = await collectHighlightData(now, refDate, db);
    const sources = await metricSourceInventory(refDate, db, now);
    const trend = await orgTrendSeries(refDate, 28, db);
    const cohorts = await reportCohorts(refDate, db);
    const actions = await metricIssueReportActions(now, db);
    const providerMetrics = await providerMetricSeries(refDate, db);
    const { context } = await dailyReportContext(refDate, db);
    const finance = await db.sourceCollectionRun.findFirst({ where: { source: "finance-costs", target: financeMonth(schedule.dueAt).month, completedAt: { lte: now } }, orderBy: { completedAt: "desc" } });
    const parsedCost = orgReportDocumentSchema.shape.costs.safeParse(finance?.coverage ?? null);
    const costSnapshot = parsedCost.success && parsedCost.data ? { ...parsedCost.data, collectedAt: parsedCost.data.collectedAt ?? finance?.completedAt?.toISOString() } : null;
    const doc = assembleOrgReportDocument({ data, narrative: null, costs: costSnapshot ?? null, origin: "published", generatedAt: now });
    doc.edition = {
      cutoffAt: schedule.cutoffAt.toISOString(), dueAt: schedule.dueAt.toISOString(), frozenAt: now.toISOString(),
      inputHash: "", sources, trend, cohorts, providerMetrics, weekly: weeklyReportSummary(trend, schedule.dueAt), context, changes: [], conclusions: [...context.map((line) => line.replace(/^- /, "")), ...reportConclusions(doc)].slice(0, 3), actions,
    };
    doc.edition.inputHash = reportFactsHash(doc);
    return { data, doc };
}

function weeklyReportSummary(trend: Awaited<ReturnType<typeof orgTrendSeries>>, now: Date) {
  if (new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", weekday: "short" }).format(now) !== "Mon") return [];
  const latest = trend.slice(-7), previous = trend.slice(-14, -7);
  // 대상별 획득 범위가 다른 일간 합계를 주간 성장률로 오인하지 않는다.
  return [`주간 관측: 최근 7일 중 GA4 ${latest.filter((point) => point.ga4Dau !== null).length}일, 직전 주 ${previous.filter((point) => point.ga4Dau !== null).length}일 자료 확보.`, "수정 후 효과는 같은 앱·대상·버전의 관찰 기간과 표본을 확보한 뒤 판단합니다. 아래 28일 추이와 코호트를 함께 확인하세요."];
}

/** 외부 호출 전에 일관된 DB snapshot을 저장한다. 재시도는 같은 준비본을 유지한다. */
export async function prepareDailyReport(now = new Date(), refDate?: string) {
  const schedule = dailyReportSchedule(refDate ? metricDayStart(shiftMetricDay(refDate, 1)) : now), date = toDbDay(schedule.refDate);
  if (now < schedule.cutoffAt) throw new Error("REPORT_BEFORE_CUTOFF");
  const existing = await prisma.orgReportPreparation.findUnique({ where: { date } });
  if (existing) {
    if (!existing.enrichedAt && existing.publishedVersion === null) {
      const doc = parseOrgReportDocument(existing.document);
      const attachment = doc ? await dailyReportImage(doc).catch(() => null) : null;
      if (attachment) await prisma.orgReportPreparation.updateMany({ where: { id: existing.id, enrichedAt: null, publishedVersion: null }, data: { attachment: attachment as unknown as Prisma.InputJsonObject } });
    }
    return { preparationId: existing.id, refDate: schedule.refDate, reused: true };
  }
  const prepared = await retryPrismaConflict(() => prisma.$transaction(async (db) => {
    const raced = await db.orgReportPreparation.findUnique({ where: { date } });
    if (raced) return { row: raced, doc: null, data: null };
    const { data, doc } = await freezeDailyReport(now, schedule.refDate, db);
    const row = await db.orgReportPreparation.create({ data: { date, document: doc as unknown as Prisma.InputJsonObject, preparedAt: now } });
    return { row, doc, data };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 }));
  if (!prepared.doc || !prepared.data) return { preparationId: prepared.row.id, refDate: schedule.refDate, reused: true };
  // 11시에는 이 작업을 기다리지 않는다. 실패하면 저장된 수치·고정 문장으로 발행한다.
  const [narrative, attachment] = await Promise.allSettled([
    metricNarrative(prepared.data), dailyReportImage(prepared.doc),
  ]);
  const doc = prepared.doc;
  if (narrative.status === "fulfilled") {
    doc.narrative = narrative.value.text;
    doc.narrativeMeta = { fallback: narrative.value.fallback, provider: narrative.value.provider, model: narrative.value.model, promptVersion: narrative.value.promptVersion };
  }
  await prisma.orgReportPreparation.updateMany({ where: { id: prepared.row.id, publishedVersion: null }, data: {
    enrichment: { narrative: doc.narrative, narrativeMeta: doc.narrativeMeta ?? null, costs: doc.costs } as unknown as Prisma.InputJsonObject,
    ...(attachment.status === "fulfilled" ? { attachment: attachment.value as unknown as Prisma.InputJsonObject } : {}),
    enrichedAt: new Date(),
  } });
  return { preparationId: prepared.row.id, refDate: schedule.refDate, reused: false };
}

export async function dailyReportImage(doc: OrgReportDocument) {
  const { reportChartSvg, ga4ChartContext } = await import("./discord-chart");
  const sharp = (await import("sharp")).default;
  const points = (doc.edition?.trend ?? []).slice(-7);
  const charts = [
    { title: `활성·신규 사용자 · ${doc.refDate}`, ...ga4ChartContext(doc), unit: "명", source: "GA4 · 앱 사이 사용자 중복 포함 · 발행 입력 고정", series: [
      { label: "활성 합계", color: "#2563eb", values: points.map((point) => point.ga4Dau) },
      { label: "신규 합계", color: "#059669", values: points.map((point) => point.ga4NewUsers) },
    ] },

  ];
  const buffers: Buffer[] = [];
  for (const chart of charts) buffers.push(await sharp(Buffer.from(reportChartSvg({ ...chart, days: "days" in chart ? chart.days as string[] : points.map((point) => point.date) }))).png().toBuffer());
  buffers.push(await sharp(Buffer.from(appComparisonSvg(doc))).png().toBuffer());
  const heights = await Promise.all(buffers.map(async (input) => (await sharp(input).metadata()).height!));
  let top = 0;
  const panels = buffers.map((input, index) => {
    const panel = { input, left: 0, top };
    top += heights[index];
    return panel;
  });
  const bytes = await sharp({ create: { width: 960, height: top, channels: 4, background: "#ffffff" } })
    .composite(panels).png().toBuffer();
  return { filename: "daily-report.png", contentType: "image/png", base64: bytes.toString("base64") };
}

/** 발행은 저장된 준비본과 outbox만 사용한다. 문서·버전·알림·발행 표시는 한 transaction이다. */
export async function publishDailyReport(now = new Date(), refDate?: string) {
  const schedule = dailyReportSchedule(refDate ? metricDayStart(shiftMetricDay(refDate, 1)) : now);
  if (now < schedule.dueAt) throw new Error("REPORT_BEFORE_PUBLICATION");
  // 대체 고정은 별도 일관된 snapshot에서 수행한다. 발행 transaction은 준비본만 읽는다.
  await retryPrismaConflict(() => prisma.$transaction(async (db) => {
    const prepared = await db.orgReportPreparation.findUnique({ where: { date: toDbDay(schedule.refDate) } });
    const previous = await db.orgReportDaily.findUnique({ where: { date: toDbDay(schedule.refDate) } });
    if (parseOrgReportDocument(previous?.report)?.published && prepared?.publishedVersion == null) throw new Error("REPORT_ALREADY_PUBLISHED");
    if (prepared) return;
    const { doc } = await freezeDailyReport(now, schedule.refDate, db);
    await db.orgReportPreparation.create({ data: { date: toDbDay(schedule.refDate), document: doc as unknown as Prisma.InputJsonObject, preparedAt: now } });
  }, { timeout: 120_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
  return retryPrismaConflict(() => prisma.$transaction(async (db) => {
    let preparation = await db.orgReportPreparation.findUniqueOrThrow({ where: { date: toDbDay(schedule.refDate) } });
    if (preparation.publishedVersion !== null) return { preparationId: preparation.id, refDate: schedule.refDate, version: preparation.publishedVersion, reused: true };
    const claim = await db.orgReportPreparation.updateMany({ where: { id: preparation.id, publishedVersion: null }, data: { publishedVersion: 0 } });
    if (!claim.count) {
      const current = await db.orgReportPreparation.findUniqueOrThrow({ where: { id: preparation.id } });
      return { preparationId: current.id, refDate: schedule.refDate, version: current.publishedVersion, reused: true };
    }
    preparation = await db.orgReportPreparation.findUniqueOrThrow({ where: { id: preparation.id } });
    const doc = parseOrgReportDocument(preparation.document);
    if (!doc?.edition) throw new Error("REPORT_PREPARATION_INVALID");
    const enriched = preparation.enrichment as { narrative?: string; narrativeMeta?: OrgReportDocument["narrativeMeta"]; costs?: OrgReportDocument["costs"] } | null;
    if (enriched) { doc.narrative = enriched.narrative ?? null; doc.narrativeMeta = enriched.narrativeMeta; doc.costs = enriched.costs ?? null; }
    doc.generatedAt = now.toISOString();
    doc.published = { factsHash: doc.edition.inputHash, dedupeKey: metricHighlightDedupeKey(doc.refDate)+":metric-insights", publishedAt: now.toISOString(),
      observed: doc.edition.sources.filter((source) => ["observed", "empty"].includes(source.state)).length,
      expected: doc.edition.sources.filter((source) => source.state !== "not_applicable").length, corrections: 0 };
    const { version } = await saveOrgReport(doc, db);
    const url = orgReportUrl(doc.refDate, version);
    const eventId = await enqueueNotification({ dedupeKey: doc.published.dedupeKey, kind: "OPERATIONAL_EVENT", occurredAt: now,
      payload: { text: renderDailyEdition(doc, version, url), refDate: doc.refDate, reportVersion: version,
        report: { category: "change", reason: "SCHEDULED_DAILY_REPORT" }, sender: SEORI_SENDER, editable: true,
        ...(preparation.attachment ? { attachment: preparation.attachment as Prisma.InputJsonObject } : {}),
        ...(url ? { components: [{ type: 1, components: [{ type: 2, style: 5, label: `전체 보고서 v${version}`, url }] }] } : {}),
      }, destinations: notificationDestinations(["metric-insights"]) }, db);
    await requeueNotification(eventId, db);
    await enqueueFinancialEdition(doc,url,now,db);
    await db.orgReportPreparation.update({ where: { id: preparation.id }, data: { publishedVersion: version } });
    return { preparationId: preparation.id, refDate: doc.refDate, version, eventId, reused: false };
  }, { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }));
}

/** 공급자 지연을 포괄하는 최근 8일의 발행본만 기존 정정 경로로 확인한다. */
export async function correctRecentDailyReports(now = new Date()) {
  const days = metricDayWindow(lastElapsedMetricDay(now), 8);
  const from = days[0], to = days.at(-1)!;
  const reports = await prisma.orgReportDaily.findMany({
    where: { date: { gte: toDbDay(from), lte: toDbDay(to) } },
    select: { date: true }, orderBy: { date: "desc" },
  });
  const results: Array<Awaited<ReturnType<typeof correctDailyReport>>> = [];
  for (const report of reports) {
    results.push(await correctDailyReport(now, dbDay(report.date)));
  }
  return { from, to, processed: results.length, corrected: results.filter((result) => result.action === "corrected").length, results };
}

/** 늦은 자료는 새 버전에 보존하고 같은 outbox 메시지의 숫자·그림·링크를 함께 고친다. */
export async function correctDailyReport(now = new Date(), refDate = shiftMetricDay(lastElapsedMetricDay(now), -1)) {
  const initial = await prisma.orgReportDaily.findUnique({ where: { date: toDbDay(refDate) } });
  const before = initial ? parseOrgReportDocument(initial.report) : null;
  if (!before?.published || !before.edition) return { day: refDate, action: "none", version: null, requeued: 0 };
  const frozen = await prisma.$transaction((db) => freezeDailyReport(now, refDate, db), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000,
  });
  if (sameReportFacts(before, frozen.doc)) return { day: refDate, action: "none", version: initial!.version, requeued: 0 };
  const [attachment, narrative] = await Promise.all([
    dailyReportImage(frozen.doc).catch(() => null), metricNarrative(frozen.data),
  ]);
  frozen.doc.narrative = narrative.text;
  frozen.doc.narrativeMeta = {fallback:narrative.fallback,provider:narrative.provider,model:narrative.model,promptVersion:narrative.promptVersion};
  return prisma.$transaction(async (db) => {
    // 동일 날짜의 정정을 직렬화한다. 이전 버전 확인과 outbox 갱신을 분리하지 않는다.
    await db.$queryRaw`SELECT id FROM org_report_daily WHERE date = ${toDbDay(refDate)} FOR UPDATE`;
    const latest = await db.orgReportDaily.findUnique({ where: { date: toDbDay(refDate) } });
    const previous = latest ? parseOrgReportDocument(latest.report) : null;
    if (!previous?.published || !previous.edition) return { day: refDate, action: "none", version: null, requeued: 0 };
    const doc = frozen.doc;
    if (previous.edition && previous.edition.frozenAt >= doc.edition!.frozenAt) return { day: refDate, action: "none", version: latest!.version, requeued: 0 };
    if (sameReportFacts(previous, doc)) return { day: refDate, action: "none", version: latest!.version, requeued: 0 };
    doc.edition!.replacesVersion = latest!.version;
    doc.edition!.changes = reportCorrectionDiff(previous, doc);
    // 해설은 이 고정 입력으로 새로 생성했다. 더 최신 정정이 먼저 발행됐으면 위에서 반환한다.
    doc.published = { ...previous.published, factsHash: doc.edition!.inputHash, corrections: previous.published.corrections + 1 };
    const { version } = await saveOrgReport(doc, db);
    const url = orgReportUrl(refDate, version);
    if (!doc.published.dedupeKey.endsWith(":metric-insights")) return {day:refDate,action:"corrected",version,requeued:0};
    const eventId = await enqueueNotification({ dedupeKey: doc.published.dedupeKey, kind: "OPERATIONAL_EVENT", occurredAt: now,
      payload: { text: renderDailyEdition(doc, version, url), reportVersion: version, refDate,
        report: { category: "change", reason: "DAILY_REPORT_CORRECTION" }, sender: SEORI_SENDER, editable: true,
        ...(attachment ? { attachment: attachment as unknown as Prisma.InputJsonObject } : {}),
        ...(url ? { components: [{ type: 1, components: [{ type: 2, style: 5, label: `정정 보고서 v${version}`, url }] }] } : {}),
      }, destinations: notificationDestinations(["metric-insights"]) }, db);
    const requeued = await requeueNotification(eventId, db);
    await enqueueFinancialEdition(doc,url,now,db);
    return { day: refDate, action: "corrected", version, requeued };
  }, { timeout: 30_000 });
}

async function enqueueFinancialEdition(doc:OrgReportDocument,url:string|null,now:Date,db:Prisma.TransactionClient){
 const dedupeKey=`finance-daily:${doc.refDate}`,fingerprint=JSON.stringify(financialReportFacts(doc));
 const prior=await db.notificationEvent.findUnique({where:{dedupeKey},select:{id:true,payload:true}});
 if((prior?.payload as {financialFingerprint?:string}|null)?.financialFingerprint===fingerprint)return;
 const eventId=await enqueueNotification({dedupeKey,kind:"OPERATIONAL_EVENT",occurredAt:now,payload:{text:renderFinancialEdition(doc,url),financialFingerprint:fingerprint,editable:true,sender:SEORI_SENDER,report:{category:"change",reason:"DAILY_FINANCIAL_REPORT"}},destinations:notificationDestinations(["app-ops"])},db);
 if(prior)await requeueNotification(eventId,db);
}

export function appComparisonSvg(doc:OrgReportDocument){
 const apps=doc.apps.filter(a=>a.ga4!==null).sort((a,b)=>b.ga4!.dau-a.ga4!.dau).slice(0,6),max=Math.max(1,...apps.map(a=>a.ga4!.dau)),height=130+Math.max(1,apps.length)*72;
 const esc=(s:string)=>s.replace(/[<>&"']/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&apos;"})[c]!);
 const rows=apps.map((a,i)=>{const y=130+i*72;return `<text x="40" y="${y}" font-size="24">${esc(a.displayName.slice(0,24))}</text><rect x="380" y="${y-25}" width="${450*a.ga4!.dau/max}" height="30" fill="#2563eb" rx="4"/><text x="920" y="${y}" font-size="26" text-anchor="end">${a.ga4!.dau}명</text>`;}).join("");
 return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}"><rect width="960" height="${height}" fill="white"/><g font-family="Noto Sans CJK KR, Apple SD Gothic Neo, sans-serif" fill="#0f172a"><text x="40" y="44" font-size="30" font-weight="700">앱별 활성 사용자 · ${doc.refDate}</text><text x="40" y="82" font-size="20">GA4 · 같은 기준일 · 미수집 앱 제외</text>${rows||'<text x="40" y="140" font-size="26">기준일 관측 없음</text>'}</g></svg>`;
}
