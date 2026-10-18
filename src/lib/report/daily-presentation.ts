import { createHash } from "node:crypto";
import { METRIC_SPECS } from "@/lib/core/metric-highlights";
import type { OrgReportDocument } from "@/lib/core/org-report-schema";
import { coverageSummary } from "./daily-contract";
import { sourceStateLabel } from "@/lib/insights/collection";
import { discordActionLines } from "./action-presentation";

function canonicalFact(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isInteger(value)) return Number(value.toPrecision(15));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  return value;
}

export function reportConclusions(doc: OrgReportDocument): string[] {
  const conclusions = [...doc.movements]
    .filter((row) => row.verdict === "lowlight" || row.verdict === "highlight")
    .sort((a, b) => b.score - a.score)
    .slice(0, 3).map((row) => {
      const metric = METRIC_SPECS.find((spec) => spec.key === row.metricKey);
      return `${row.label} · ${metric?.ko ?? row.metricKey}: ${metric?.format(row.latest) ?? row.latest} (기준 ${row.baseline === null ? "없음" : metric?.format(row.baseline) ?? row.baseline})`;
    });
  return conclusions.length ? conclusions : ["확보된 자료에서 기준선을 넘는 변화가 없습니다. 미수집 자료는 판단에서 제외했습니다."];
}

/** 해설·실행 시각·run ID가 달라졌다는 이유로 숫자가 같은 보고서를 정정하지 않는다. */
export function reportFactsHash(doc: OrgReportDocument): string {
  return createHash("sha256").update(JSON.stringify({
    refDate: doc.refDate, summary: doc.summary, apps: doc.apps, movements: doc.movements,
    retention: doc.retention, trend: doc.edition?.trend,
    referrers: [...doc.referrers].sort((a, b) => a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0),
    cohorts: doc.edition?.cohorts,
    costs: doc.costs ? { month: doc.costs.month, figures: doc.costs.figures, summaryLines: doc.costs.summaryLines, warnings: doc.costs.warnings } : null,
    providerMetrics: doc.edition?.providerMetrics.map((series) => ({ ...series, points: series.points.map((point) => ({ ...point, runId: undefined, sourceHash: undefined, sourceUri: undefined, configRevisionId: undefined })) })),
    sources: doc.edition?.sources.map(({ slug, source, reportType, account, state, dataThrough }) => ({ slug, source, reportType, account, state, dataThrough: dataThrough && dataThrough > doc.refDate ? doc.refDate : dataThrough })),
    actions: doc.edition?.actions,
    context: doc.edition?.context,
  // MySQL JSON의 키 순서와 실수 직렬화 차이로 같은 사실을 정정하지 않는다.
  }, canonicalFact)).digest("hex");
}

export function reportCorrectionDiff(before: OrgReportDocument, after: OrgReportDocument) {
  const changes: Array<{ label: string; before: string; after: string }> = [];
  const compare = (label: string, a: string | number | null, b: string | number | null) => {
    if (a !== b) changes.push({ label, before: a === null ? "미수집" : String(a), after: b === null ? "미수집" : String(b) });
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
  if (!changes.length && reportFactsHash(before) !== reportFactsHash(after)) changes.push({ label: "비교표·판정·근거 갱신", before: "이전 발행본의 값·판정·수집 범위", after: "새 발행본의 값·판정·수집 범위 · 정정 전후 링크에서 대조" });
  return changes;
}

export function renderDailyEdition(doc: OrgReportDocument, version: number, url: string | null): string {
  const edition = doc.edition;
  const coverage = coverageSummary(edition?.sources ?? []);
  const movementLines = (verdict: "highlight" | "lowlight") => doc.movements
    .filter((row) => row.verdict === verdict).sort((a, b) => b.score - a.score).slice(0, 3)
    .map((row) => {
      const metric = METRIC_SPECS.find((spec) => spec.key === row.metricKey);
      return `- ${row.label} · ${metric?.ko ?? row.metricKey}: ${metric?.format(row.latest) ?? row.latest}`;
    });
  return [
    `**일간 보고 · ${doc.refDate} · v${version}${doc.published?.corrections ? " · 정정" : ""}**`,
    ...(edition?.changes.slice(0, 3).map((change) => `- 정정 ${change.label}: ${change.before} → ${change.after}`) ?? []),
    ...(edition?.conclusions ?? reportConclusions(doc)).map((line) => `- ${line}`),
    ...(edition?.weekly ?? []).map((line) => `- ${line}`),
    ...(edition?.providerMetrics.filter((series) => series.verdict === "highlight" || series.verdict === "lowlight").slice(0, 3).map((series) => { const point = series.points.find((point) => point.day === series.assessmentDay) ?? series.points.at(-1)!; return `- ${series.verdict === "highlight" ? "좋아진 점" : "나빠진 점"} · ${series.appName} · ${series.metric}${series.segment ? ` · ${series.segment}` : ""}: ${point.value?.toLocaleString("ko-KR") ?? "미확인"} ${series.currency ?? series.unit} · ${point.day} ${series.timeZone}`; }) ?? []),
    "", "**좋아진 점**", ...(!movementLines("highlight").length ? ["- 기준선을 넘는 변화 없음"] : movementLines("highlight")),
    "**나빠진 점**", ...(!movementLines("lowlight").length ? ["- 기준선을 넘는 변화 없음"] : movementLines("lowlight")),
    "", `GA4 활성 합계 ${doc.summary.ga4.apps ? `${doc.summary.ga4.dau.toLocaleString("ko-KR")}명` : "미수집"} · 관측 ${doc.summary.ga4.apps}개 앱 · ${doc.refDate}`,
    `토스 광고 추정 수익 ${doc.summary.console.iaaKrw === null ? "미수집" : `${Math.round(doc.summary.console.iaaKrw).toLocaleString("ko-KR")}원`} · 기준 ${doc.consoleMeta.refDate ?? "미확인"}`,
    `수집 범위 ${coverage.observed}/${coverage.expected}개 앱·보고서 · 누락은 0으로 계산하지 않습니다.`,
    "**다음 행동**",
    ...discordActionLines(edition?.actions ?? []),
    ...(url ? [`[같은 버전의 전체 보고서·근거](${url})`] : []),
  ].join("\n");
}
