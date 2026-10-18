import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { metricReportPartitions } from "./report-batches";
import { METRIC_DICTIONARY, unifiedMetricRowSchema, metricChange, type MetricSlice, type UnifiedMetricRow } from "./unified-metrics";
import { metricDaysBetween } from "./metric-day";

export const providerSeriesSchema = z.object({
  appId: z.string(), appName: z.string(), source: z.string(), account: z.string(), resource: z.string(),
  reportType: z.string(), timeZone: z.string(), metric: unifiedMetricRowSchema.innerType().shape.metric,
  segment: z.string().default(""), assessmentDay: z.string().nullable().default(null),
  currency: z.string().nullable(), unit: z.string(), definition: z.string(),
  weekdayBaseline: z.number().nullable().default(null), weekdayObservations: z.number().int().default(0),
  points: z.array(z.object({ day: z.string(), value: z.number().nullable(), numerator: z.number().nullable(), denominator: z.number().nullable(), state: unifiedMetricRowSchema.innerType().shape.state, valueStatus: unifiedMetricRowSchema.innerType().shape.valueStatus, sourceHash: z.string(), sourceUri: z.string(), runId: z.string(), configRevisionId: z.string() })),
  dimensions: z.array(z.object({ day: z.string(), metric: unifiedMetricRowSchema.innerType().shape.metric, value: z.number().nullable(), labels: z.record(z.string()), currency: z.string().nullable(), state: z.string() })),
  verdict: z.enum(["insufficient", "flat", "observing", "highlight", "lowlight"]),
}).strict();
export type ProviderSeries = z.infer<typeof providerSeriesSchema>;

export function semanticDimensions(row: UnifiedMetricRow) {
  const keys = row.metric === "subscriptions" ? ["State Metric", "State Metric Grouping", "Event", "Event Sub Type", "Event Grouping"]
    : ["store_downloads", "device_installs", "device_uninstalls"].includes(row.metric) ? ["Download Type"] : ["store_engagement", "unique_events", "install_delete_events"].includes(row.metric) ? ["Event", "Engagement Type"] : [];
  return keys.filter((key) => row.dimensions[key] !== undefined).map((key) => `${key}: ${row.dimensions[key]}`).join(" · ");
}

/** 하나의 날짜 partition 내 서로 겹치지 않는 차원 행만 축약. 고유 기기는 합산하지 않는다. */
export function aggregateReportRows(rows: UnifiedMetricRow[]) {
  const first = rows[0], definition = first && METRIC_DICTIONARY[first.metric];
  if (!first || !definition || rows.some((row) => row.metric !== first.metric || row.currency !== first.currency)) throw new Error("REPORT_AGGREGATE_SCOPE");
  const zeroDenominator = (row: UnifiedMetricRow) => definition.aggregation === "ratio" && row.state === "not_applicable" && row.denominator === 0 && row.numerator !== null;
  const missing = rows.some((row) => !zeroDenominator(row) && (!["observed", "empty"].includes(row.state) || row.value === null));
  const numerator = definition.aggregation === "ratio" && !rows.some((row) => row.numerator === null) ? rows.reduce((sum, row) => sum + row.numerator!, 0) : null;
  const denominator = definition.aggregation === "ratio" && !rows.some((row) => row.denominator === null) ? rows.reduce((sum, row) => sum + row.denominator!, 0) : null;
  const value = missing ? null : definition.aggregation === "none" ? rows.length === 1 ? first.value : null
    : definition.aggregation === "ratio" ? numerator !== null && denominator && denominator > 0 ? numerator * (first.metric === "ad_ecpm" ? 1000 : 100) / denominator : null
    : rows.reduce((sum, row) => sum + row.value!, 0);
  return { ...first, value, numerator, denominator, dimensions: {}, state: value === null ? denominator === 0 && !missing ? "not_applicable" as const : "partial" as const : value === 0 ? "empty" as const : "observed" as const,
    valueStatus: rows.some((row) => row.valueStatus === "provisional") ? "provisional" as const : first.valueStatus };
}

/** 웹·발행·CSV의 공용 조회. 광고/스토어/GA4의 다른 정의를 한 합계로 만들지 않는다. */
export async function providerMetricSeries(end: string, db: Prisma.TransactionClient = prisma, appId?: string): Promise<ProviderSeries[]> {
  const partitions = await metricReportPartitions(end, db, appId);
  const apps = await db.app.findMany({ where: { id: { in: [...new Set(partitions.map((one) => one.appId))] } }, select: { id: true, displayName: true } });
  const series = new Map<string, ProviderSeries>();
  for (const partition of partitions) {
    const groups = new Map<string, UnifiedMetricRow[]>();
    for (const row of partition.rows) {
      const semantics = semanticDimensions(row);
      const key = JSON.stringify([row.metric, row.currency, semantics]); groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values()) {
      const combined = aggregateReportRows(rows), metric = combined.metric;
      const segment = semanticDimensions(rows[0]);
      const key = JSON.stringify([segment, partition.appId, partition.source, partition.accountId, partition.resourceId, partition.reportType, partition.timeZone, metric, combined.currency]);
      const value = series.get(key) ?? { appId: partition.appId, appName: apps.find((app) => app.id === partition.appId)?.displayName ?? partition.appId,
        source: partition.source, account: partition.accountId, resource: partition.resourceId, reportType: partition.reportType, timeZone: partition.timeZone,
        metric, segment, assessmentDay: null, currency: combined.currency, unit: METRIC_DICTIONARY[metric].unit, definition: METRIC_DICTIONARY[metric].definition, points: [], dimensions: [], verdict: "insufficient" as const, weekdayBaseline: null, weekdayObservations: 0 };
      value.points.push({ day: partition.periodStart, value: combined.value, numerator: combined.numerator, denominator: combined.denominator, state: combined.state, valueStatus: combined.valueStatus, sourceHash: partition.sourceHash, sourceUri: partition.sourceUri, runId: partition.runId, configRevisionId: partition.configRevisionId });
      // 발행 문서는 최신 날짜의 차원 표 200행까지 담고 원천은 별도 보존한다.
      if (value.dimensions.length && value.dimensions[0].day < partition.periodStart) value.dimensions = [];
      if (!value.dimensions.length || value.dimensions[0].day === partition.periodStart) value.dimensions.push(...rows.slice(0, Math.max(0, 200 - value.dimensions.length)).map((row) => ({ day: partition.periodStart, metric, value: row.value, labels: row.dimensions, currency: row.currency, state: row.state })));
      series.set(key, value);
    }
  }
  return [...series.values()].map(assessProviderSeries);
}

/** 최신 잠정 표시와 마지막 분석 가능한 비교의 기준일을 분리한다. */
export function assessProviderSeries(value: ProviderSeries): ProviderSeries {
  value.points.sort((a, b) => a.day.localeCompare(b.day));
  const current = value.points.findLast((point) => point.value !== null && point.valueStatus !== "provisional" && ["observed", "empty"].includes(point.state));
  value.assessmentDay = current?.day ?? null;
  value.weekdayObservations = 0; value.weekdayBaseline = null; value.verdict = "insufficient";
  if (!current || value.metric.startsWith("provider_")) return value;
  const valid = value.points.filter((point) => point.day < current.day && point.value !== null && point.valueStatus !== "provisional" && ["observed", "empty"].includes(point.state));
  const weekdays = valid.filter((point) => [7, 14, 21, 28].includes(metricDaysBetween(current.day, point.day))).map((point) => point.value!).sort((a, b) => a - b);
  value.weekdayObservations = weekdays.length;
  value.weekdayBaseline = weekdays.length === 4 ? (weekdays[1] + weekdays[2]) / 2 : null;
  const slice = (point: typeof current): MetricSlice => ({ source: value.source, account: value.account, periodStart: point.day, periodEnd: point.day, grain: "daily", timeZone: value.timeZone, subjects: [value.appId, value.resource, value.reportType, value.segment], row: { metric: value.metric, value: point.value, numerator: point.numerator, denominator: point.denominator, currency: value.currency, dimensions: {}, state: point.state, valueStatus: point.valueStatus } });
  value.verdict = metricChange(slice(current), valid.map(slice));
  return value;
}
