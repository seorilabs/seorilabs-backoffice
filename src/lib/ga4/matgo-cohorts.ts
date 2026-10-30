import { queryLandedEventTables, runGa4Query } from "./bigquery";
import type { Ga4Target } from "./datasets";
import { buildMatgoCohortsSql, isoDay, mapMatgoCohortRow } from "./matgo-cohorts-sql";

type Source = {
  landed: typeof queryLandedEventTables;
  query: (target: Ga4Target, sql: string) => Promise<Record<string, unknown>[]>;
};
export async function queryMatgoCohorts(target: Ga4Target, start: string, end: string,
  source: Source = { landed: queryLandedEventTables, query: runGa4Query }) {
  const startDay = isoDay(start), endDay = isoDay(end);
  const first = new Date(startDay + "T00:00:00Z"), last = new Date(endDay + "T00:00:00Z");
  const span = (last.getTime() - first.getTime()) / 86400000 + 1;
  if (span < 1 || span > 14) throw new Error("조회 범위는 최대 14일입니다.");
  const landed = await source.landed(target, start, end);
  const observed = [...landed].filter(day => day >= start && day <= end).sort();
  const missingDays = Array.from({ length: span }, (_, i) => new Date(first.getTime() + i*86400000).toISOString().slice(0,10)).filter(day => !landed.has(day.replaceAll("-", "")));
  const common = { startDay, endDay, observedThrough: observed.length ? isoDay(observed.at(-1)!) : null,
    missingDays, population: "첫 실행에서 분석을 허용한 새 저장. 전체 설치 비율이 아닙니다." };
  if (!observed.length) return { ...common, status: "unavailable", cohorts: [] };
  const rows = await source.query(target, buildMatgoCohortsSql(target, start, end, landed));
  return { ...common, status: missingDays.length ? "partial" : rows.length ? "available" : "no_new_install_cohort",
    cohorts: rows.map(mapMatgoCohortRow) };
}
