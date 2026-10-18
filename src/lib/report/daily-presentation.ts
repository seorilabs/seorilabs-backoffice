import { createHash } from "node:crypto";
import { METRIC_SPECS } from "@/lib/core/metric-highlights";
import type { OrgReportDocument } from "@/lib/core/org-report-schema";
import { coverageSummary } from "./daily-contract";

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
    cohorts: doc.edition?.cohorts,
    sources: doc.edition?.sources.map(({ slug, source, state, dataThrough }) => ({ slug, source, state, dataThrough: dataThrough && dataThrough > doc.refDate ? doc.refDate : dataThrough })),
    actions: doc.edition?.actions,
    context: doc.edition?.context,
  })).digest("hex");
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
  for (const app of after.apps) compare(`${app.displayName} 활성(명)`, before.apps.find((row) => row.slug === app.slug)?.ga4?.dau ?? null, app.ga4?.dau ?? null);
  const known = (doc: OrgReportDocument) => doc.edition?.cohorts.reduce((sum, cohort) => sum + cohort.values.filter((cell) => cell.returned !== null).length, 0) ?? 0;
  compare("잔존 코호트 복귀 수 확보 칸", known(before), known(after));
  for (const cohort of after.edition?.cohorts ?? []) for (const cell of cohort.values) {
    const prior = before.edition?.cohorts.find((row) => row.appId === cohort.appId && row.cohortDate === cohort.cohortDate)?.values.find((row) => row.day === cell.day);
    if (prior && prior.returned !== cell.returned) compare(`${cohort.appName} ${cohort.cohortDate} D${cell.day} 복귀(명)`, prior.returned, cell.returned);
  }
  for (const source of after.edition?.sources ?? []) {
    const prior = before.edition?.sources.find((row) => row.appId === source.appId && row.source === source.source && row.reportType === source.reportType);
    if (prior && prior.state !== source.state) compare(`${source.appName} ${source.reportType} 수집 상태`, prior.state, source.state);
  }
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
    "", "**좋아진 점**", ...(!movementLines("highlight").length ? ["- 기준선을 넘는 변화 없음"] : movementLines("highlight")),
    "**나빠진 점**", ...(!movementLines("lowlight").length ? ["- 기준선을 넘는 변화 없음"] : movementLines("lowlight")),
    "", `GA4 활성 합계 ${doc.summary.ga4.apps ? `${doc.summary.ga4.dau.toLocaleString("ko-KR")}명` : "미수집"} · 관측 ${doc.summary.ga4.apps}개 앱 · ${doc.refDate}`,
    `토스 광고 추정 수익 ${doc.summary.console.iaaKrw === null ? "미수집" : `${Math.round(doc.summary.console.iaaKrw).toLocaleString("ko-KR")}원`} · 기준 ${doc.consoleMeta.refDate ?? "미확인"}`,
    `수집 범위 ${coverage.observed}/${coverage.expected}개 앱·보고서 · 누락은 0으로 계산하지 않습니다.`,
    "**다음 행동**",
    ...(edition?.actions.length ? edition.actions.slice(0, 3).map((action) => `- ${action.appName}: ${action.title}${action.url ? ` ${action.url}` : ""}`) : ["- 등록할 근거를 갖춘 새 개선 후보가 없습니다."]),
    ...(url ? [`[같은 버전의 전체 보고서·근거](${url})`] : []),
  ].join("\n");
}
