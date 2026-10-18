import type { Prisma } from "@prisma/client";
import { dbDay, toDbDay, shiftMetricDay } from "@/lib/analytics/metric-day";
import type { DailyEdition } from "./daily-contract";

export async function reportCohorts(end: string, db: Prisma.TransactionClient): Promise<DailyEdition["cohorts"]> {
  const range = { gte: toDbDay(shiftMetricDay(end, -36)), lte: toDbDay(end) };
  const ledger = await db.metricCollectionLedger.findMany({ where: { source: "ga4", day: range, state: { in: ["observed", "empty"] } }, select: { appId: true, day: true } });
  const verified = new Set(ledger.map((row) => `${row.appId}:${dbDay(row.day)}`));
  const rows = await db.appMetricDaily.findMany({ where: { date: range, cohortUsers: { not: null }, app: { status: { not: "DEPRECATED" } } }, include: { app: { select: { displayName: true } } }, orderBy: [{ appId: "asc" }, { date: "desc" }] });
  return rows.filter((row) => verified.has(`${row.appId}:${dbDay(row.date)}`)).map((row) => ({
    appId: row.appId, appName: row.app.displayName, cohortDate: dbDay(row.date), users: row.cohortUsers!,
    values: ([1, 3, 7, 14, 30] as const).map((day) => {
      const returned = row[`d${day}Users`];
      return { day, returned, pct: returned !== null && row.cohortUsers! > 0 ? 100 * returned / row.cohortUsers! : null };
    }),
  }));
}
