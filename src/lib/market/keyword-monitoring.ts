import { decodeRank } from "./keyword-history";
import { prisma } from "@/lib/prisma";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import {
  dbDay,
  metricDayOf,
  metricDayStart,
  parseMetricDay,
  shiftMetricDay,
  toDbDay,
} from "@/lib/analytics/metric-day";
import { collectionTarget, sourceStateLabel } from "@/lib/insights/collection";
export interface KeywordApp {
  id: string;
  displayName: string;
  iosBundle: string | null;
  status: string;
  revision: number | null;
  countries: string[];
  keywords: string[];
}
interface Observation {
  appId: string;
  target: string;
  country: string;
  day: Date;
  observedAt: Date;
  value: unknown;
  sourceUrl: string;
}
interface Attempt {
  appId: string | null;
  source: string;
  target: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
}
export interface KeywordRow {
  appId: string;
  appName: string;
  country: string;
  term: string;
  revision: number | null;
  state: string;
  rank: number | null;
  rankLabel: string;
  previousRank: number | null;
  previousDay: string | null;
  change: string;
  observedAt: Date | null;
  sourceUrl: string;
}
function rankOf(value: unknown): number | null {
  const rank =
    value && typeof value === "object"
      ? (value as { rank?: unknown }).rank
      : null;
  return typeof rank === "number" &&
    Number.isInteger(rank) &&
    rank >= 1 &&
    rank <= 200
    ? rank
    : null;
}
export function buildKeywordRows(
  apps: KeywordApp[],
  observations: Observation[],
  attempts: Attempt[],
  day: string,
): KeywordRow[] {
  return apps
    .filter((app) => app.status === "ACTIVE" && app.iosBundle)
    .flatMap((app) =>
      app.countries.flatMap((country) =>
        app.keywords.map((term) => {
          const history = observations
            .filter(
              (row) =>
                row.appId === app.id &&
                row.country === country &&
                row.target === term,
            )
            .sort((a, b) => b.day.getTime() - a.day.getTime());
          const current = history.find((row) => dbDay(row.day) === day);
          const previous = history.find(
            (row) =>
              dbDay(row.day) < day && decodeRank(row.value).state !== "invalid",
          );
          const latest = (source: string, target: string) =>
            attempts
              .filter(
                (run) =>
                  run.appId === app.id &&
                  run.source === source &&
                  run.target === collectionTarget(target),
              )
              .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
          const keyword = latest("apple-keyword", `${country}:${term}`);
          const listing = latest(
            "apple-public-lookup",
            `${app.iosBundle}:${country}`,
          );
          let state = "미수집";
          if (keyword && !["observed", "empty"].includes(keyword.status))
            state = sourceStateLabel(keyword.status);
          else if (keyword && current) state = "수집됨";
          else if (current && !listing) state = "수집됨";
          else if (listing?.status === "empty") state = "공개 리스팅 미확인";
          else if (listing && !["observed", "empty"].includes(listing.status))
            state = sourceStateLabel(listing.status);
          if (
            state === "수집됨" &&
            current &&
            decodeRank(current.value).state === "invalid"
          )
            state = "자료 형식 오류";
          const rank =
            state === "수집됨" && current ? rankOf(current.value) : null;
          const before = previous ? rankOf(previous.value) : null;
          const change =
            state !== "수집됨"
              ? "비교 불가"
              : !previous
                ? "첫 관측"
                : rank === before
                  ? "변화 없음"
                  : before === null
                    ? "결과 목록 진입"
                    : rank === null
                      ? "결과 목록 이탈"
                      : `${Math.abs(before - rank)}계단 ${rank < before ? "상승" : "하락"}`;
          return {
            appId: app.id,
            appName: app.displayName,
            country,
            term,
            revision: app.revision,
            state,
            rank,
            rankLabel:
              state === "수집됨"
                ? rank === null
                  ? "결과 목록에 없음"
                  : `${rank}위`
                : state,
            previousRank: before,
            previousDay: previous ? dbDay(previous.day) : null,
            change,
            observedAt:
              state === "수집됨"
                ? (keyword?.completedAt ?? current?.observedAt ?? null)
                : (keyword?.startedAt ?? listing?.startedAt ?? null),
            sourceUrl:
              current?.sourceUrl ??
              `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${country}&entity=software&limit=200`,
          };
        }),
      ),
    );
}
export async function keywordMonitoring(
  appId?: string,
  now = new Date(),
  requestedDay?: string,
) {
  const parsedDay = parseMetricDay(requestedDay);
  const day =
    parsedDay && parsedDay <= metricDayOf(now) ? parsedDay : metricDayOf(now);
  const configured = await prisma.app.findMany({
    where: { ...visibleAppWhere, ...(appId ? { id: appId } : {}) },
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      displayName: true,
      iosBundle: true,
      status: true,
      configRevisions: {
        where: { status: "ACTIVE" },
        orderBy: { revision: "desc" },
        take: 1,
      },
    },
  });
  const apps = configured.map((app): KeywordApp => {
    const parsed = configRevisionPayloadSchema.safeParse(
      app.configRevisions[0]?.payload,
    );
    const monitoring =
      parsed.success && parsed.data.monitoring?.enabled
        ? parsed.data.monitoring
        : null;
    return {
      id: app.id,
      displayName: app.displayName,
      iosBundle: app.iosBundle,
      status: app.status,
      revision: app.configRevisions[0]?.revision ?? null,
      countries: monitoring?.countries ?? [],
      keywords: monitoring?.keywords ?? [],
    };
  });
  const ids = apps.map((app) => app.id);
  const [history, attempts] = await Promise.all([
    prisma.marketObservation.findMany({
      where: {
        kind: "keyword",
        appId: { in: ids },
        day: { gte: toDbDay(shiftMetricDay(day, -90)), lte: toDbDay(day) },
        observedAt: { lte: now },
      },
    }),
    prisma.sourceCollectionRun.findMany({
      where: {
        appId: { in: ids },
        source: { in: ["apple-keyword", "apple-public-lookup"] },
        startedAt: {
          gte: metricDayStart(day),
          lt: metricDayStart(shiftMetricDay(day, 1)),
          lte: now,
        },
      },
    }),
  ]);
  const rows = buildKeywordRows(apps, history, attempts, day);
  return {
    day,
    apps,
    rows,
    collected: rows.filter((row) => row.state === "수집됨").length,
  };
}
