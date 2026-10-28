import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { metricDayOf, parseMetricDay } from "@/lib/analytics/metric-day";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification, requeueNotification, retryDeadLetterNotification } from "@/lib/notifications/outbox";
import { sourceStateLabel } from "@/lib/insights/collection-state";
import { keywordCycle, marketLabel } from "./keyword-cycle";
import { rankReportKey, rankReportText, type RankReport, type RankReportItem } from "./rank-report";
import { keywordSuccess } from "./keyword-collector";
import type { KeywordRow } from "./keyword-monitoring";
export const rankRowIdentity = (r: Pick<KeywordRow, "appId" | "country" | "term" | "market" | "source" | "language">) => JSON.stringify([r.appId, r.market ?? "app-store", r.source ?? "apple-search-api", r.country, r.language ?? "en_us", r.term]);
export function selectCycleItems(candidates: RankReportItem[], previous: RankReport[], brand: (item: RankReportItem) => boolean) {
  const introduced = previous.flatMap(report => report.items);
  const eligible = candidates.filter(item => !introduced.some(before => rankRowIdentity(before) === rankRowIdentity(item) && before.rank === item.rank && (item.rank!==null || before.resultCount===item.resultCount)));
  const counts = (item: RankReportItem) => introduced.filter(before => rankRowIdentity(before) === rankRowIdentity(item)).length;
  const sorted = [...eligible].sort((a,b) => counts(a)-counts(b) || a.term.localeCompare(b.term) || a.appId.localeCompare(b.appId));
  const selected: RankReportItem[] = [];
  const canAdd = (item: RankReportItem) => selected.length < 3 && (!brand(item) || !selected.some(brand));
  const add = (pool: RankReportItem[], limit: number) => {
    let added = 0;
    for (const distinct of [true, false]) for (const item of pool) {
      if (added >= limit || selected.some(before=>rankRowIdentity(before) === rankRowIdentity(item)) || !canAdd(item)) continue;
      if (distinct && selected.some(before => before.appId === item.appId)) continue;
      // 다른 앱 후보가 있으면 같은 앱을 먼저 채우지 않는다.
      if (!distinct && eligible.some(other => !selected.some(before=>rankRowIdentity(before) === rankRowIdentity(other)) && canAdd(other) && !selected.some(before => before.appId === other.appId))) continue;
      selected.push(item); added++;
    }
  };
  add(sorted.filter(item => item.score > 0).sort((a,b)=>b.score-a.score || counts(a)-counts(b)), 2);
  add(sorted.map(item => item.score > 0 ? {...item, score:0, reason:item.change} : item), 3-selected.length);
  return selected;
}
export function rankChangeBoundary(previous: {rank:number|null;resultCount:number|null}|undefined, current: {rank:number|null;resultCount:number|null}) {
  if (!previous) return undefined;
  return [10,20,50,100].find(limit=>{
    if ((previous.rank === null && (previous.resultCount ?? 0)<limit) || (current.rank === null && (current.resultCount ?? 0)<limit)) return false;
    return (previous.rank !== null && previous.rank<=limit) !== (current.rank !== null && current.rank<=limit);
  });
}
export async function sendCycleKeywordRanks(now = new Date(), requestedDay?: string): Promise<{batchId:string;status?:string;eventId?:string;items?:string[]}> {
  if (requestedDay !== undefined && (!parseMetricDay(requestedDay) || requestedDay > metricDayOf(now))) throw Error("INVALID_REPORT_DAY");
  const cycle = keywordCycle(now);
  if (requestedDay && requestedDay !== cycle.day) throw Error("REPORT_REQUIRES_CURRENT_CYCLE");
  const batch = await prisma.keywordCollectionBatch.findUnique({ where: { id: cycle.id } });
  if (!batch?.completedAt) return { batchId: cycle.id, status: "collection_incomplete" };
  const current = await prisma.keywordObservation.findMany({ where: { batchId: batch.id } });
  if (!current.some(row=>keywordSuccess(row.status))) return { batchId: cycle.id, status: "no_observations" };
  return prisma.$transaction(async tx => {
    const dedupeKey = `keyword-report-cycle:${cycle.day}-${cycle.reportSlot}`;
    const existing = await tx.notificationEvent.findUnique({ where: { dedupeKey } });
    const since = new Date(now.getTime()-7*86400000);
    const previousEvents = await tx.notificationEvent.findMany({ where: { dedupeKey: { startsWith: "keyword-report-cycle:", not:dedupeKey }, occurredAt: { gte: since, lte: now } }, select: { payload: true } });
    const previousReports = previousEvents.flatMap(event => { const report = (event.payload as {rankReport?: RankReport}).rankReport; return report ? [report] : []; });
    const apps = await tx.app.findMany({ where: { id: { in: [...new Set(current.map(row=>row.appId))] } }, select: { id: true, displayName: true, repoFullName: true } });
    const cycleHistory = await tx.keywordObservation.findMany({ where: { appId: { in: apps.map(app=>app.id) }, observedAt: { lt: batch.startedAt, gte: new Date(now.getTime()-90*86400000) }, status: { in: ["observed", "absent"] } }, orderBy: { observedAt: "desc" } });
    const legacy = await tx.marketObservation.findMany({where:{kind:"keyword",appId:{in:apps.map(app=>app.id)},observedAt:{lt:batch.startedAt,gte:new Date(now.getTime()-90*86400000)}},orderBy:{observedAt:"desc"}});
    const history = [...cycleHistory, ...legacy.flatMap(row=>{
      const value=row.value as {rank?:unknown;resultCount?:number};
      if(value.rank !== null && !(typeof value.rank === "number" && Number.isInteger(value.rank) && value.rank>=1 && value.rank<=200))return [];
      return [{appId:row.appId,market:"app-store",source:"apple-search-api",language:"en_us",country:row.country,term:row.target,rank:value.rank as number|null,resultCount:value.resultCount??null,observedAt:row.observedAt,status:value.rank===null?"absent":"observed"}];
    })].sort((a,b)=>b.observedAt.getTime()-a.observedAt.getTime());
    const rows: KeywordRow[] = [], candidates: RankReportItem[] = [];
    for (const row of current) {
      const identity = rankRowIdentity(row), previous = history.find(before => rankRowIdentity(before) === identity && keywordSuccess(before.status));
      const appName = apps.find(app=>app.id === row.appId)?.displayName ?? row.appId;
      const success=keywordSuccess(row.status),state=success?"수집됨":sourceStateLabel(row.status);
      const ranked = !success ? state : row.rank === null ? `반환된 ${row.resultCount}개 목록에 없음` : `${row.rank}위`;
      const change = !success ? "비교 불가" : !previous ? "첫 관측" : previous.rank === row.rank ? "변화 없음" : previous.rank === null ? "결과 목록 진입" : row.rank === null ? "결과 목록 이탈" : `${Math.abs(row.rank-previous.rank)}계단 ${row.rank < previous.rank ? "상승" : "하락"}`;
      const item: KeywordRow = { appId: row.appId, appName, country: row.country, term: row.term, revision: row.revision, state, rank: success?row.rank:null, rankLabel: ranked, previousRank: previous?.rank ?? null, previousDay: previous ? metricDayOf(previous.observedAt) : null, change, observedAt: success?row.observedAt:null, attemptedAt:row.observedAt.toISOString(),attemptState:state, sourceUrl: row.sourceUrl, market: row.market, source: row.source, language: row.language, resultCount: row.resultCount, previousAt: previous?.observedAt.toISOString() ?? null, observationId: row.id, isBrand: row.isBrand };
      rows.push(item);
      if(!success)continue;
      const crossed = rankChangeBoundary(previous,row);
      const material = previous && previous.rank !== null && row.rank !== null && Math.min(previous.rank,row.rank) <= 50 && Math.abs(previous.rank-row.rank) >= 10;
      const dates = Array.from({length:28}, (_,i) => metricDayOf(new Date(now.getTime()-(27-i)*86400000)));
      candidates.push({ ...item, observedAt: row.observedAt.toISOString(), points: dates.map(day => { const found = day === cycle.day ? row : history.find(before => rankRowIdentity(before) === identity && metricDayOf(before.observedAt) === day); return { day, rank: found?.rank ?? null, state: !found ? "missing" : found.rank === null ? "outside" : "ranked" }; }), reason: crossed ? `상위 ${crossed}개 ${row.rank !== null && row.rank <= crossed ? "진입" : "이탈"}` : material ? "상위권의 뚜렷한 순위 변화" : change, score: crossed ? 1000-crossed : material ? 100 : 0 });
    }
    const brand = (item: RankReportItem) => { if(item.isBrand)return true; const term = item.term.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); const name = item.appName.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); const slug = apps.find(app=>app.id===item.appId)?.repoFullName.split("/")[1].replace(/[^\p{L}\p{N}]/gu, "") ?? ""; return name.includes(term) || term.includes(name) || Boolean(slug && (slug.includes(term) || term.includes(slug))); };
    const items = selectCycleItems(candidates, previousReports, brand);
    if (!items.length) return { batchId: cycle.id, status: "no_new_results" };
    const report: RankReport = { version: 1, day: cycle.day, capturedAt: now.toISOString(), items, rows: rows.map(row=>({...row, observedAt: row.observedAt?.toISOString() ?? null})) };
    const previousReport=(existing?.payload as {rankReport?:RankReport}|undefined)?.rankReport;
    if(existing && previousReport && rankReportKey(previousReport)===rankReportKey(report)){
      await retryDeadLetterNotification(existing.id,tx);
      return {batchId:cycle.id,eventId:existing.id,status:"same_cycle"};
    }
    const base = env.optional("AUTH_URL") || "https://backoffice.vzyx.xyz", url = `${base}/feedback/rank-reports/${rankReportKey(report)}`;
    const payload = { text: rankReportText(report,url), editable: true, sender: "seori", refDate: cycle.day, report: { category: "change", reason: "SEARCH_VISIBILITY_OBSERVATION" }, rankReport: report, components: [{ type:1, components:[{type:2,style:5,label:"전체 보고서와 근거 열기",url}] }], embed: { title: "검색 위치 관측", color: 0x2563eb, footer: `${cycle.day} ${cycle.reportSlot.slice(0,2)}:${cycle.reportSlot.slice(2)} KST` } };
    await enqueueNotification({ dedupeKey:`keyword-report:${rankReportKey(report)}`,kind:"OPS_ALERT",payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonObject,occurredAt:now,destinations:[] },tx);
    const eventId = await enqueueNotification({ dedupeKey,kind:"OPS_ALERT",payload:JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonObject,occurredAt:now,destinations:discordDestinations(["metrics-daily"]) },tx);
    if(existing)await requeueNotification(eventId,tx);
    return { batchId:cycle.id,eventId,items:items.map(item=>`${marketLabel(item.market)}:${item.term}`) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}
