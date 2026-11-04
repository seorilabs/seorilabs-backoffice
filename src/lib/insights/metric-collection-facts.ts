import { shiftMetricDay } from "@/lib/analytics/metric-day";
import { validatedEvidence, type Evidence } from "./contract";

export interface MetricCollectionPoint {
  key: string;
  label: string;
  day: string;
  metrics: Record<string, { label: string; value: number | null; unit: string }>;
}
export function metricCollectionSnapshot(source: "ga4" | "ait_console", day: string, state: string, points: MetricCollectionPoint[]) {
  const label = source === "ga4" ? "GA4" : "앱인토스";
  const current = points.filter(point => point.day === day);
  const prior = new Map(points.filter(point => point.day === shiftMetricDay(day, -1)).map(point => [point.key, point]));
  const rows = current.flatMap(point => Object.entries(point.metrics).flatMap(([key, metric]) => {
    if (metric.value === null || !Number.isFinite(metric.value)) return [];
    const before = prior.get(point.key)?.metrics[key]?.value;
    const comparable = before != null && Number.isFinite(before);
    return [{ label: `${point.label} · ${metric.label}`.slice(0, 100),
      value: `${comparable ? `전일 ${before}${metric.unit} → ` : ""}${metric.value}${metric.unit}`,
      change: comparable ? Math.abs(metric.value - before) / Math.max(Math.abs(before), 1) : null }];
  }));
  const conclusion = state === "failed" ? "수집 실패 — 확인한 자료 범위만 보고" : !rows.length ? "판단할 자료 부족 — 기준일에 확인된 지표 없음"
    : rows.every(row => row.change === 0) ? "주요 변화 없음 — 비교 가능한 관측값이 전일과 같음"
      : rows.every(row => row.change === null) ? "판단할 자료 부족 — 전일 비교 자료 없음" : "전일과 비교한 관측값 변화";
  const sourceLabel = `${label} · ${day} · 이번 수집의 확인된 값 · 앱·리스팅별 비교`;
  const facts: Evidence[] = [
    { id: "coverage", label: `${label} 수집 범위`, value: `기준일 ${day}, 확인 ${new Set(current.map(point => point.key)).size}개 앱·리스팅, 상태 ${{observed: "정상", complete: "정상", partial: "부분 수집", failed: "실패"}[state] ?? "자료 확인 필요"}`, source: sourceLabel },
    { id: "conclusion", label: "이번 수집의 결론", value: conclusion, source: sourceLabel },
    ...rows.sort((a, b) => (b.change ?? -1) - (a.change ?? -1)).slice(0, 8).map((row, i) => ({
      id: `metric_${i}`, label: row.label, value: row.value.slice(0, 160), source: sourceLabel,
    })),
  ];
  return { source, day, queued: false, facts: validatedEvidence(facts) };
}
