import { z } from "zod";
const rowSchema = z.object({
  startTime: z
    .object({ year: z.number().int(), month: z.number().int(), day: z.number().int() })
    .optional(),
  dimensions: z
    .array(
      z.object({
        dimension: z.string(),
        stringValue: z.string().optional(),
        int64Value: z.string().optional(),
      }),
    )
    .default([]),
  metrics: z
    .array(
      z.object({ metric: z.string(), decimalValue: z.object({ value: z.string() }).optional() }),
    )
    .default([]),
});
const valueSchema = z.object({
  slices: z.array(
    z.object({
      metricSet: z.string(),
      cohort: z.enum(["OS_PUBLIC", "APP_TESTERS"]),
      period: z.object({
        startTime: z.object({
          year: z.number().int(),
          month: z.number().int(),
          day: z.number().int(),
        }),
      }),
      rows: z.array(rowSchema),
    }),
  ),
});
function decimal(value: string | undefined) {
  if (!value || !/^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
export function vitalsPresentation(value: unknown) {
  const parsed = valueSchema.safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.slices.flatMap((slice) =>
    slice.rows.map((row) => {
      const expected =
        slice.metricSet === "crashRateMetricSet"
          ? "userPerceivedCrashRate"
          : "userPerceivedAnrRate";
      const dim = (key: string) => {
        const found = row.dimensions.find((dim) => dim.dimension === key);
        return found?.stringValue ?? found?.int64Value ?? "미상";
      };
      const rate = decimal(
        row.metrics.find((metric) => metric.metric === expected)?.decimalValue?.value,
      );
      const date = row.startTime ?? slice.period.startTime;
      return {
        cohort: slice.cohort === "OS_PUBLIC" ? "공개 OS" : "앱 테스터",
        kind: expected === "userPerceivedCrashRate" ? "사용자 체감 충돌" : "사용자 체감 응답 없음",
        rate: rate !== null && rate <= 100 ? rate : null,
        users: decimal(
          row.metrics.find((metric) => metric.metric === "distinctUsers")?.decimalValue?.value,
        ),
        country: dim("countryCode"),
        version: dim("versionCode"),
        date: `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`,
      };
    }),
  );
}
