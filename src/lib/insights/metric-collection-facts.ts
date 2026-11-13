import { evaluateMovement } from "@/lib/core/metric-highlights";
import { shiftMetricDay } from "@/lib/analytics/metric-day";
import { validatedEvidence, type Evidence } from "./contract";

export interface MetricCollectionPoint {
  key: string;
  label: string;
  day: string;
  metrics: Record<string, { label: string; value: number | null; unit: string; sample?: number | null }>;
}
export function metricCollectionSnapshot(source: "ga4" | "ait_console", day: string, state: string, points: MetricCollectionPoint[]) {
  const label = source === "ga4" ? "GA4" : "앱인토스";
  const current = points.filter(point => point.day === day);
  const prior = new Map(points.filter(point => point.day === shiftMetricDay(day, -1)).map(point => [point.key, point]));
  const rows = current.flatMap(point => Object.entries(point.metrics).flatMap(([key, metric]) => {
    if (metric.value === null || !Number.isFinite(metric.value)) return [];
    const before = prior.get(point.key)?.metrics[key]?.value;
    const comparable = before != null && Number.isFinite(before);
    const metricKey = source === "ait_console" ? ({dau:"console_dau"} as Record<string,string>)[key] : ({dau:"ga4_dau",newUsers:"ga4_dau",d1:"ga4_d1",adCompletions:"ga4_ad_completions"} as Record<string,string>)[key];
    const movement = metricKey && comparable ? evaluateMovement({label:point.label,metricKey,latest:metric.value,baseline:before!,sample:metric.sample,date:day}) : null;
    const material = movement?.verdict === "highlight" || movement?.verdict === "lowlight";
    const interpretation = material ? movement.change === null ? " · 이전 0에서 기준 이상의 활동 관측" : ` · ${Math.abs(movement.change).toFixed(1)}${movement.spec.pointScale ? "%p" : "%"} ${movement.verdict === "lowlight" ? "감소" : "증가"}` : "";
    return [{ material, identity:point.key, label: `${point.label} · ${metric.label}`.slice(0, 100),
      value: `${comparable ? `전일 ${before}${metric.unit} → ` : ""}${metric.value}${metric.unit}${interpretation}`,
      change: comparable ? Math.abs(metric.value - before) / Math.max(Math.abs(before), 1) : null }];
  }));
  const comparable = rows.filter(row => row.change !== null);
  const conclusion = state === "failed" ? "수집 실패 — 확인한 자료 범위만 보고" : !rows.length ? "판단할 자료 부족 — 기준일에 확인된 지표 없음"
    : comparable.length === 0 ? "판단할 자료 부족 — 전일 비교 자료 없음"
      : comparable.every(row => row.change === 0) ? "주요 변화 없음 — 비교 가능한 관측값이 전일과 같음"
      : "전일과 비교한 관측값 변화";
  const sourceLabel = `${label} · ${day} · 이번 수집의 확인된 값 · 앱·리스팅별 비교`;
  const facts: Evidence[] = [
    { id: "coverage", label: `${label} 수집 범위`, value: `기준일 ${day}, 확인 ${new Set(current.map(point => point.key)).size}개 앱·리스팅, 상태 ${{observed: "정상", complete: "정상", partial: "부분 수집", failed: "실패"}[state] ?? "자료 확인 필요"}`, source: sourceLabel },
    { id: "conclusion", label: "이번 수집의 결론", value: conclusion, source: sourceLabel },
    ...rows.sort((a, b) => (b.change ?? -1) - (a.change ?? -1)).slice(0, 8).map((row, i) => ({
      id: `${row.material ? "metric_change" : "metric"}_${i}`, label: row.label, value: row.value.slice(0, 160), source: `${sourceLabel} · ${row.identity}`.slice(0,160),
    })),
  ];
  return { source, day, queued: false, reportable: rows.some(row=>row.material), facts: validatedEvidence(facts) };
}

export function metricFactsReportable(facts: readonly Evidence[]) {return facts.some(f=>f.id.startsWith("metric_change_"));}
export function materialMetricFacts(facts: readonly Evidence[]) {return facts.filter(f=>f.id.startsWith("metric_change_")).map(f=>({label:f.label,value:f.value,source:f.source})).sort((a,b)=>a.label.localeCompare(b.label));}
