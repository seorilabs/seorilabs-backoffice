import { createHash } from "node:crypto";
import { METRIC_SPECS } from "@/lib/core/metric-highlights";
import type { OrgReportDocument } from "@/lib/core/org-report-schema";
import { sourceStateLabel } from "@/lib/insights/collection";

function canonicalFact(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  return value;
}

function sameFact(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isInteger(a) && Number.isInteger(b)) return false;
    return Number.isFinite(a) && Number.isFinite(b)
      && Math.abs(a - b) <= 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameFact(value, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    const keys = Object.keys(left).filter((key) => left[key] !== undefined);
    return keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length
      && keys.every((key) => Object.hasOwn(right, key) && sameFact(left[key], right[key]));
  }
  return false;
}

export function reportConclusions(doc: OrgReportDocument): string[] {
  const conclusions = [...doc.movements]
    .filter((row) => (row.verdict === "lowlight" || row.verdict === "highlight") && !["console_iaa","console_iap"].includes(row.metricKey))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3).map((row) => {
      const metric = METRIC_SPECS.find((spec) => spec.key === row.metricKey);
      return `${row.label} · ${metric?.ko ?? row.metricKey}: ${metric?.format(row.latest) ?? row.latest} (기준 ${row.baseline === null ? "없음" : metric?.format(row.baseline) ?? row.baseline})`;
    });
  if(!doc.summary.ga4.apps && !doc.apps.some(app=>app.listings.some(l=>l.dau!==null)))return ["판단할 자료가 부족합니다. 기준일 지표를 확인하지 못했습니다."];
  return conclusions.length ? conclusions : ["확보된 자료에서 기준선을 넘는 변화가 없습니다. 미수집 자료는 판단에서 제외했습니다."];
}

/** 해설·실행 시각·run ID가 달라졌다는 이유로 숫자가 같은 보고서를 정정하지 않는다. */
function reportFacts(doc: OrgReportDocument) {
  return {
    refDate: doc.refDate, summary: doc.summary, apps: doc.apps, movements: doc.movements,
    retention: doc.retention, trend: doc.edition?.trend,
    referrers: [...doc.referrers].sort((a, b) => a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0),
    cohorts: doc.edition?.cohorts,
    costs: doc.costs ? { month: doc.costs.month, figures: doc.costs.figures, summaryLines: doc.costs.summaryLines, warnings: doc.costs.warnings } : null,
    providerMetrics: doc.edition?.providerMetrics.map((series) => ({ ...series, points: series.points.map((point) => ({ ...point, runId: undefined, sourceHash: undefined, sourceUri: undefined, configRevisionId: undefined })) })),
    sources: doc.edition?.sources.map(({ slug, source, reportType, account, state, dataThrough }) => ({ slug, source, reportType, account, state, dataThrough: dataThrough && dataThrough > doc.refDate ? doc.refDate : dataThrough })),
    actions: doc.edition?.actions,
    context: doc.edition?.context,
  };
}

export function reportFactsHash(doc: OrgReportDocument): string {
  return createHash("sha256").update(JSON.stringify(reportFacts(doc), canonicalFact)).digest("hex");
}

/** 저장된 지문은 보존하고, 정정 판단은 DB JSON 왕복 오차를 구분해 현재 사실끼리 비교한다. */
export function sameReportFacts(before: OrgReportDocument, after: OrgReportDocument): boolean {
  return sameFact(reportFacts(before), reportFacts(after));
}

export function reportCorrectionDiff(before: OrgReportDocument, after: OrgReportDocument) {
  const changes: Array<{ label: string; before: string; after: string }> = [];
  const compare = (label: string, a: string | number | null, b: string | number | null) => {
    if (!sameFact(a, b)) changes.push({ label, before: a === null ? "미수집" : String(a), after: b === null ? "미수집" : String(b) });
  };
  compare("GA4 활성 합계(명)", before.summary.ga4.apps ? before.summary.ga4.dau : null, after.summary.ga4.apps ? after.summary.ga4.dau : null);
  compare("GA4 관측 앱", before.summary.ga4.apps, after.summary.ga4.apps);
  compare("토스 광고 추정 수익(KRW)", before.summary.console.iaaKrw, after.summary.console.iaaKrw);
  compare("토스 결제 거래액(KRW)", before.summary.console.iapTrxKrw, after.summary.console.iapTrxKrw);
  const referrers = new Set([...before.referrers, ...after.referrers].map((row) => row.dimension));
  const share = (doc: OrgReportDocument, dimension: string) => {
    const row = doc.referrers.find((item) => item.dimension === dimension);
    return row ? Number((row.rate * 100).toFixed(10)) : null;
  };
  for (const dimension of referrers) compare(`${dimension} 유입 비율(%)`, share(before, dimension), share(after, dimension));
  for (const app of after.apps) compare(`${app.displayName} 활성(명)`, before.apps.find((row) => row.slug === app.slug)?.ga4?.dau ?? null, app.ga4?.dau ?? null);
  for (const series of after.edition?.providerMetrics ?? []) {
    const match = before.edition?.providerMetrics.find((row) => row.appId === series.appId && row.source === series.source && row.account === series.account && row.resource === series.resource && row.reportType === series.reportType && row.metric === series.metric && row.segment === series.segment && row.currency === series.currency && row.timeZone === series.timeZone);
    const latest = series.points.at(-1);
    if (latest) compare(`${series.appName} ${series.metric}${series.segment ? ` · ${series.segment}` : ""} ${latest.day} ${series.currency ?? series.unit}`, match?.points.find((row) => row.day === latest.day)?.value ?? null, latest.value);
  }
  const known = (doc: OrgReportDocument) => doc.edition?.cohorts.reduce((sum, cohort) => sum + cohort.values.filter((cell) => cell.returned !== null).length, 0) ?? 0;
  compare("잔존 코호트 복귀 수 확보 칸", known(before), known(after));
  for (const cohort of after.edition?.cohorts ?? []) for (const cell of cohort.values) {
    const prior = before.edition?.cohorts.find((row) => row.appId === cohort.appId && row.cohortDate === cohort.cohortDate)?.values.find((row) => row.day === cell.day);
    if (prior && prior.returned !== cell.returned) compare(`${cohort.appName} ${cohort.cohortDate} D${cell.day} 복귀(명)`, prior.returned ?? "아직 확인 전", cell.returned ?? "아직 확인 전");
  }
  for (const source of after.edition?.sources ?? []) {
    const prior = before.edition?.sources.find((row) => row.appId === source.appId && row.source === source.source && row.reportType === source.reportType);
    if (prior && prior.state !== source.state) compare(`${source.appName} ${source.source} ${source.reportType} 수집 상태`, sourceStateLabel(prior.state), sourceStateLabel(source.state));
  }
  for (const point of after.edition?.trend ?? []) {
    const prior = before.edition?.trend.find((row) => row.date === point.date);
    if (!prior) continue;
    for (const [key, label] of Object.entries({ ga4Dau: "활성(명)", ga4NewUsers: "신규(명)", adCompletions: "광고 완료(건)", consoleDau: "토스 이용자(명)", consoleIaaKrw: "광고 추정 수익(KRW)", consoleIapTrxKrw: "구매 거래액(KRW)" })) {
      compare(`${point.date} 추이 ${label}`, prior[key as keyof typeof prior], point[key as keyof typeof point]);
    }
  }
  if (JSON.stringify(before.costs?.figures ?? null) !== JSON.stringify(after.costs?.figures ?? null)) changes.push({ label: "월 누적 비용·잔액", before: before.costs?.summaryLines.join(" · ") ?? "미수집", after: after.costs?.summaryLines.join(" · ") ?? "미수집" });
  // 이전 버전 링크와 함께 비교표·판정·근거의 갱신을 누락 없이 알린다.
  if (!changes.length && !sameReportFacts(before, after)) changes.push({ label: "비교표·판정·근거 갱신", before: "이전 발행본의 값·판정·수집 범위", after: "새 발행본의 값·판정·수집 범위 · 정정 전후 링크에서 대조" });
  return changes;
}

export function renderDailyEdition(doc: OrgReportDocument, version: number, url: string | null): string {
 const ga4=doc.summary.ga4,trend=doc.edition?.trend??[],before=trend.find(p=>p.date===new Date(Date.parse(doc.refDate+"T00:00:00Z")-86400000).toISOString().slice(0,10));
 const n=(v:number|null|undefined,unit:string)=>v==null ? "미수집" : `${v.toLocaleString("ko-KR")}${unit}`;
 const comparison=(v:number|null|undefined,unit:string)=>v==null ? "비교값 미수집" : `전일 ${n(v,unit)}`;
 const figures=ga4.apps ? [
  `GA4 활성 사용자 ${n(ga4.dau,"명")} · ${comparison(ga4.dauPrev,"명")}`,
  `GA4 신규 사용자 ${n(ga4.newUsers,"명")} · ${comparison(before?.ga4NewUsers,"명")}`,
  `GA4 보상형 광고 완료 ${n(ga4.adCompletions,"회")} · ${comparison(before?.adCompletions,"회")}`,
 ] : ["GA4 기준일 지표 미수집"];
 if(doc.retention?.d1Pct!=null)figures.push(`GA4 D1 잔존율 ${n(doc.retention.d1Pct,"%")} · ${doc.retention.cohortDate} 신규 ${n(doc.retention.users,"명")} 코호트`);
 const usage=doc.edition?.providerMetrics.find(series=>series.metric === "session_seconds");
 if(usage){const point=usage.points.find(p=>p.day===usage.assessmentDay)??usage.points.at(-1);if(point?.value!=null)figures.push(`${usage.source} ${usage.appName} 세션 시간 ${n(point.value,"초")} · ${point.day} ${usage.timeZone}`);}
 for(const app of doc.apps)for(const listing of app.listings){if(listing.dau!==null)figures.push(`앱인토스 ${app.displayName} (${listing.label??listing.miniAppId}) 활성 사용자 ${n(listing.dau,"명")} · 기준 ${listing.date}`);}

 const insights=reportConclusions(doc).slice(0,3);
 return [`**일간 지표 보고 · ${doc.refDate} · v${version}${doc.published?.corrections ? " · 정정" : ""}**`,
  ...figures.slice(0,6),...insights.map(line=>`- ${line}`),
  ...(editionChanges(doc).length ? editionChanges(doc).slice(0,3).map(line=>`정정: ${line}`):[]),
  ...(url?[`[전체 보고서·비교·근거](${url})`]:[])].join("\n");
}
function editionChanges(doc:OrgReportDocument){return (doc.edition?.changes??[]).filter(c=>!/수집|비용|잔액|거래|수익/.test(c.label)).map(c=>`${c.label}: ${c.before} → ${c.after}`);}

export function financialReportFacts(doc:OrgReportDocument){return {summary:doc.summary.console,refDate:doc.consoleMeta.refDate,costs:doc.costs?{month:doc.costs.month,figures:doc.costs.figures,summaryLines:doc.costs.summaryLines}:null};}
export function renderFinancialEdition(doc:OrgReportDocument,url:string|null){
 const money=(v:number|null)=>v===null?"미수집":`${Math.round(v).toLocaleString("ko-KR")}원`;
 const c=doc.summary.console;
 return [`**일간 재무 보고 · ${doc.refDate}**`,`앱인토스 광고 추정 수익 ${money(c.listings && doc.consoleMeta.refDate ? c.iaaKrw : null)}`,`앱인토스 결제 거래액 ${money(c.listings && doc.consoleMeta.refDate ? c.iapTrxKrw : null)}`,`앱인토스 결제 정산액 ${money(c.listings && doc.consoleMeta.refDate ? c.iapSettlementKrw : null)}`,`금액 기준일 ${doc.consoleMeta.refDate??"미확인"}`,...(doc.costs?.summaryLines??[]),"거래액·추정 수익·정산액은 서로 다른 금액입니다.",...(url?[`[금액·비용·잔액 근거](${url})`]:[])].join("\n");
}
