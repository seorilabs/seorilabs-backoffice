import { dbDay, shiftMetricDay } from "@/lib/analytics/metric-day";
export function reportD1Retention(
  refDate: string,
  series: Array<{
    rowsDesc: Array<{ date: Date; cohortUsers?: number | null; d1Users?: number | null }>;
  }>,
  expectedApps: number,
) {
  const cohortDate = shiftMetricDay(refDate, -1);
  const rows = series.flatMap((app) =>
    app.rowsDesc.filter(
      (row) => dbDay(row.date) === cohortDate && row.cohortUsers != null && row.d1Users != null,
    ),
  );
  const users = rows.reduce((sum, row) => sum + row.cohortUsers!, 0);
  const returned = rows.reduce((sum, row) => sum + row.d1Users!, 0);
  return {
    cohortDate,
    users,
    returned,
    d1Pct: users ? (100 * returned) / users : null,
    observedApps: rows.length,
    expectedApps,
  };
}
