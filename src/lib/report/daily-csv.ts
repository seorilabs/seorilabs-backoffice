import type { OrgReportDocument } from "@/lib/core/org-report-schema";

function cell(value: string | number | null) {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const safe = /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function dailyReportCsv(doc: OrgReportDocument, version: number) {
  const rows: Array<Array<string | number | null>> = [["보고서 기준일", "버전", "앱", "소스", "지표 기준일", "지표", "값", "단위", "수치 상태"]];
  for (const app of doc.apps) {
    rows.push([doc.refDate, version, app.displayName, "GA4", app.ga4?.date ?? null, "DAU", app.ga4?.dau ?? null, "명", app.ga4 ? "관측" : "미수집"]);
    for (const listing of app.listings) {
      rows.push([doc.refDate, version, app.displayName, `앱인토스 ${listing.miniAppId}`, listing.date, "광고 추정 수익", listing.iaaKrw, "KRW", "추정 수익"]);
      rows.push([doc.refDate, version, app.displayName, `앱인토스 ${listing.miniAppId}`, listing.date, "결제 거래액", listing.iapTrxKrw, "KRW", "거래액"]);
    }
  }
  for (const series of doc.edition?.providerMetrics ?? []) for (const point of series.points) rows.push([doc.refDate, version, series.appName, `${series.source} · ${series.account} · ${series.timeZone} · ${series.reportType}`, point.day, `${series.metric}${series.segment ? ` · ${series.segment}` : ""}`, point.value, series.currency ?? series.unit, `${point.state} · ${point.valueStatus} · 분자 ${point.numerator ?? "미확인"} / 분모 ${point.denominator ?? "미확인"} · ${point.sourceHash}`]);
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
