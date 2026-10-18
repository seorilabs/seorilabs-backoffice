import { z } from "zod";
import { metricDaysBetween } from "./metric-day";

type MetricDefinition = { label: string; unit: string; aggregation: "sum" | "ratio" | "none"; direction: "higher" | "lower" | "neutral"; definition: string };
const count = (label: string, definition: string, direction: MetricDefinition["direction"] = "higher"): MetricDefinition => ({ label, definition, unit: "건", aggregation: "sum", direction });
const money = (label: string, definition: string, direction: MetricDefinition["direction"] = "higher"): MetricDefinition => ({ label, definition, unit: "통화", aggregation: "sum", direction });
export const METRIC_DICTIONARY = {
  store_downloads: count("스토어 다운로드", "스토어 보고서의 다운로드. 설치·첫 실행과 구분"),
  store_impressions: count("스토어 노출", "스토어 노출 횟수. 고유 방문자와 구분"),
  store_page_views: count("스토어 페이지 조회", "스토어 페이지 조회 횟수. 설치·고유 방문자와 구분"),
  store_taps: count("스토어 탭", "스토어의 탭 횟수"),
  device_installs: count("기기 설치", "실제 설치 보고. 사용자 설치·다운로드와 구분"),
  device_uninstalls: count("기기 삭제", "실제 삭제 보고", "lower"),
  user_installs: count("사용자 설치", "Google Play 사용자 기준 설치"),
  user_uninstalls: count("사용자 삭제", "Google Play 사용자 기준 삭제", "lower"),
  store_engagement: count("스토어 발견·참여", "Event·Engagement Type별 원천 횟수. 서로 다른 행동을 전환으로 잇지 않음", "neutral"),
  install_delete_events: count("설치·삭제 행동", "Event별 횟수. 설치와 삭제를 분리해 표시", "neutral"),
  sessions: count("세션", "소스의 세션 정의·동의 범위에 한정"),
  session_seconds: { ...count("세션 시간 합계", "소스 보고서의 총 세션 시간"), unit: "초", direction: "neutral" as const },
  crashes: count("오류", "보고된 오류 횟수. 영향 사용자와 구분", "lower"),
  unique_devices: { ...count("고유 기기", "해당 차원 조합의 고유 기기. 조합 사이 중복 제거 불가"), aggregation: "none" as const },
  unique_events: { ...count("고유 참여", "해당 차원 조합의 고유 횟수. 조합 사이 합산 불가"), aggregation: "none" as const },
  ad_requests: count("광고 요청", "광고 SDK의 요청 수"),
  matched_requests: count("광고 응답", "광고가 반환된 요청 수"),
  ad_impressions: count("광고 노출", "실제 광고 노출. 앱의 광고 버튼 노출과 구분"),
  ad_clicks: count("광고 클릭", "광고 클릭 수", "neutral"),
  ad_estimated_revenue: money("광고 추정 수익", "AdMob 우선. 같은 앱·기간 GA4 광고 수익과 중복 합산 금지"),
  ad_ecpm: { label: "광고 eCPM", unit: "통화/천회", aggregation: "ratio", direction: "neutral", definition: "광고 추정 수익 / 광고 노출 × 1,000. 각 행의 eCPM을 평균하지 않음" } satisfies MetricDefinition,
  purchase_sales: money("구매액", "세금·수수료·환불·기간 차이가 있는 거래액"),
  purchase_proceeds: money("구매 수익", "공급자가 보고한 proceeds. 정산 확인과 구분"),
  settled_proceeds: money("정산 확인", "정산 보고서로 확인한 금액"),
  refunds: money("환불", "환불 금액", "lower"),
  purchases: count("구매", "구매 횟수. 결제 사용자와 구분"),
  subscriptions: { ...count("구독", "구독 보고서의 상태·이벤트별 수"), direction: "neutral" as const },
  cost: money("비용", "같은 기간·통화의 실제 비용. 배분 근거 없이 앱에 나누지 않음", "lower"),
  opt_in: { label: "분석 동의 비율", unit: "%", aggregation: "ratio", direction: "neutral", definition: "원천 분자·분모가 모두 있을 때 재계산" } satisfies MetricDefinition,
  match_rate: { label: "광고 응답률", unit: "%", aggregation: "ratio", direction: "higher", definition: "광고 응답 / 광고 요청. 분자·분모 재계산" } satisfies MetricDefinition,
  show_rate: { label: "광고 표시율", unit: "%", aggregation: "ratio", direction: "higher", definition: "광고 노출 / 광고 응답. 분자·분모 재계산" } satisfies MetricDefinition,
} as const;
export type UnifiedMetricKey = keyof typeof METRIC_DICTIONARY;
export const unifiedMetricRowSchema = z.object({
  metric: z.enum(Object.keys(METRIC_DICTIONARY) as [UnifiedMetricKey, ...UnifiedMetricKey[]]),
  value: z.number().finite().nullable(), numerator: z.number().finite().nullable().default(null),
  denominator: z.number().finite().nonnegative().nullable().default(null),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  dimensions: z.record(z.string().max(80), z.string().max(500)),
  state: z.enum(["observed", "empty", "not_landed", "partial", "needs_input", "needs_instrumentation", "failed", "not_applicable"]),
  valueStatus: z.enum(["provisional", "analyzable", "estimated", "settled"]),
}).strict().superRefine((row, context) => {
  const metric = METRIC_DICTIONARY[row.metric];
  if (metric.unit.startsWith("통화") && !row.currency) context.addIssue({ code: "custom", message: "금액에는 통화가 필요합니다." });
  if (!["observed", "empty"].includes(row.state) && row.value !== null) context.addIssue({ code: "custom", message: "관측되지 않은 수치를 0이나 실적으로 저장할 수 없습니다." });
  if (row.state === "empty" && row.value !== 0) context.addIssue({ code: "custom", message: "확인된 0은 실제 0이어야 합니다." });
  if (row.state === "observed" && row.value === null) context.addIssue({ code: "custom", message: "관측 값이 필요합니다." });
  if (row.value !== null && metric.unit === "건" && (!Number.isSafeInteger(row.value) || (row.value < 0 && row.metric !== "purchases"))) context.addIssue({ code: "custom", message: "횟수는 정수이고 구매 취소 외에는 음수일 수 없습니다." });
  if (row.value !== null && metric.unit === "%" && (row.numerator === null || row.denominator === null || row.denominator <= 0 || row.numerator < 0 || Math.abs(row.value - 100 * row.numerator / row.denominator) > 0.00001)) context.addIssue({ code: "custom", message: "비율은 실제 분자·분모와 일치해야 합니다." });
  if (row.value !== null && row.metric === "ad_ecpm" && (row.numerator === null || row.denominator === null || row.denominator <= 0 || Math.abs(row.value - 1000 * row.numerator / row.denominator) > 0.00001)) context.addIssue({ code: "custom", message: "eCPM의 수익·노출 분모가 일치해야 합니다." });
});
export type UnifiedMetricRow = z.infer<typeof unifiedMetricRowSchema>;

export interface MetricSlice { source: string; account: string; periodStart: string; periodEnd: string; grain: "daily" | "monthly" | "cohort"; timeZone: string; subjects: string[]; row: UnifiedMetricRow }

export function comparisonKey(slice: MetricSlice) {
  const dimensions = Object.entries(slice.row.dimensions).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([slice.source, slice.account, slice.grain, slice.timeZone, slice.row.metric, slice.row.currency, dimensions, [...slice.subjects].sort()]);
}

/** 집계 기간까지 일치하는 자료만 합산한다. 고유값은 중복 제거 근거가 없으면 합치지 않는다. */
export function sumMetricSlices(slices: readonly MetricSlice[]): number | null {
  if (!slices.length || slices.some((slice) => !["observed", "empty"].includes(slice.row.state))) return null;
  const first = slices[0];
  if (slices.some((slice) => comparisonKey(slice) !== comparisonKey(first) || slice.periodStart !== first.periodStart || slice.periodEnd !== first.periodEnd)) throw new Error("METRIC_SCOPE_MISMATCH");
  const definition = METRIC_DICTIONARY[first.row.metric];
  if (definition.aggregation === "none") return slices.length === 1 ? first.row.value : null;
  if (definition.aggregation === "ratio") {
    if (slices.some((slice) => slice.row.numerator === null || slice.row.denominator === null)) return null;
    const denominator = slices.reduce((sum, slice) => sum + slice.row.denominator!, 0);
    return denominator > 0 ? (first.row.metric === "ad_ecpm" ? 1000 : 100) * slices.reduce((sum, slice) => sum + slice.row.numerator!, 0) / denominator : null;
  }
  return slices.some((slice) => slice.row.value === null) ? null : slices.reduce((sum, slice) => sum + slice.row.value!, 0);
}

export function metricChange(current: MetricSlice, previous: readonly MetricSlice[]) {
  const days = new Map<string, MetricSlice>();
  for (const slice of previous) {
    const elapsed = metricDaysBetween(current.periodStart, slice.periodStart);
    if (comparisonKey(slice) === comparisonKey(current) && elapsed >= 1 && elapsed <= 7 && slice.row.valueStatus !== "provisional" && ["observed", "empty"].includes(slice.row.state) && slice.row.value !== null) days.set(slice.periodStart, slice);
  }
  const valid = [...days.values()].sort((a, b) => b.periodStart.localeCompare(a.periodStart));
  if (current.row.value === null || current.row.valueStatus === "provisional" || !["observed", "empty"].includes(current.row.state) || valid.length < 4) return "insufficient";
  const sorted = valid.map((slice) => slice.row.value!).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const base = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, value = current.row.value;
  const definition = METRIC_DICTIONARY[current.row.metric];
  const delta = value - base;
  if (definition.direction === "neutral") return "flat";
  const threshold = definition.unit === "%" ? (current.row.denominator ?? 0) >= 50 && valid.every((slice) => (slice.row.denominator ?? 0) >= 50) && Math.abs(delta) >= 5
    : base > 0 && Math.abs(delta / base) >= .3 && (definition.unit === "통화" || Math.abs(delta) >= 5);
  if (!threshold) return "flat";
  if (definition.unit === "통화") {
    const preceding = valid[0]?.row.value;
    if (preceding === undefined || preceding === null || valid[0].periodStart !== new Date(new Date(current.periodStart).getTime() - 86400_000).toISOString().slice(0, 10) || Math.sign(preceding - base) !== Math.sign(delta) || Math.abs((preceding - base) / base) < .3) return "observing";
  }
  return (delta > 0) === (definition.direction === "higher") ? "highlight" : "lowlight";
}
