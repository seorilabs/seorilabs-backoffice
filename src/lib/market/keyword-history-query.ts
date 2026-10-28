import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { collectionTarget } from "@/lib/insights/collection";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { metricDayOf, metricDayStart, shiftMetricDay, toDbDay } from "@/lib/analytics/metric-day";
import type { KeywordApp } from "./keyword-monitoring";
import { buildKeywordHistory, eligibleKeywordApps, normalizeKeywordSelection, type HistoryParams, type RankObservation } from "./keyword-history";

const ATTEMPT_LIMIT = 10_000;
export async function keywordHistoryQuery(params: HistoryParams, now = new Date()) {
  const configured = await prisma.app.findMany({ where: visibleAppWhere, orderBy: { displayName: "asc" }, select: {
    id: true, displayName: true, iosBundle: true, playPackage: true, status: true,
    configRevisions: { where: { status: "ACTIVE" }, orderBy: { revision: "desc" }, take: 1 },
  } });
  const apps = eligibleKeywordApps(configured.map((app): KeywordApp => {
    const parsed = configRevisionPayloadSchema.safeParse(app.configRevisions[0]?.payload);
    const monitoring = parsed.success && parsed.data.monitoring?.enabled ? parsed.data.monitoring : undefined;
    return { id: app.id, displayName: app.displayName, iosBundle: app.iosBundle, playPackage: app.playPackage, status: app.status, revision: app.configRevisions[0]?.revision ?? null, countries: monitoring?.countries ?? [], keywords: monitoring?.keywords ?? [] };
  }), params.market === "google-play" ? "google-play" : "app-store");
  const selection = normalizeKeywordSelection(apps, params, now), app = apps.find(item => item.id === selection.appId);
  if (!app) return { apps, selection, today: metricDayOf(now), app: null, history: null };
  const start = shiftMetricDay(selection.day, 1 - selection.days);
  if (selection.market === "google-play") {
    const records = await prisma.keywordObservation.findMany({ where: { appId: app.id, market: "google-play", source: "google-play-web", language: "en", country: selection.country, observedAt: { gte: metricDayStart(shiftMetricDay(start, -90)), lt: metricDayStart(shiftMetricDay(selection.day, 1)), lte: now } }, orderBy: {observedAt: "asc"} });
    const observations: RankObservation[] = records.filter(row => ["observed", "absent"].includes(row.status)).map(row => ({ appId: row.appId, target: row.term, country: row.country, day: toDbDay(metricDayOf(row.observedAt)), observedAt: row.observedAt, value: {rank: row.rank, resultCount: row.resultCount}, sourceUrl: row.sourceUrl }));
    const attempts = records.map(row => ({appId: row.appId, source:"google-play-web", target:row.country+":"+row.term, status: row.status === "observed" || row.status === "absent" ? "observed" : row.status === "unparseable" ? "unparseable" : row.status === "not_collected" ? "not_collected" : "failed", startedAt:row.observedAt, completedAt:row.observedAt}));
    return {apps, selection, today:metricDayOf(now), app, history:buildKeywordHistory(app,selection,observations,attempts,now)};
  }
  const where = { appId: app.id, kind: "keyword", country: selection.country, target: { in: app.keywords }, observedAt: { lte: now } };
  const listingTarget = collectionTarget(app.iosBundle + ":" + selection.country);
  const [observations, prior, attempts] = await Promise.all([
    prisma.marketObservation.findMany({ where: { ...where, day: { gte: toDbDay(start), lte: toDbDay(selection.day) } } }),
    // 이전 성공 날짜는 그래프 기간 밖에서도 찾는다. 형식 오류를 성공 기준으로 쓰지 않는다.
    // 바인딩된 입력과 창 함수로 검색어마다 유효한 마지막 관측 한 건만 가져온다.
    prisma.$queryRaw<RankObservation[]>(Prisma.sql`
      SELECT appId, target, country, day, observedAt, value, sourceUrl FROM (
        SELECT appId, target, country, day, observedAt, value, sourceUrl,
          ROW_NUMBER() OVER (PARTITION BY target ORDER BY day DESC, observedAt DESC) AS position
        FROM market_observation
        WHERE appId = ${app.id} AND kind = 'keyword' AND country = ${selection.country}
          AND target IN (${Prisma.join(app.keywords)}) AND day < ${toDbDay(start)} AND observedAt <= ${now}
          AND (JSON_TYPE(JSON_EXTRACT(value, '$.rank')) = 'NULL' OR (
            JSON_TYPE(JSON_EXTRACT(value, '$.rank')) IN ('INTEGER', 'DOUBLE')
            AND JSON_EXTRACT(value, '$.rank') BETWEEN 1 AND 200
            AND JSON_EXTRACT(value, '$.rank') = FLOOR(JSON_EXTRACT(value, '$.rank'))
          ))
      ) AS previous_observations WHERE position = 1
    `),
    prisma.sourceCollectionRun.findMany({ where: { appId: app.id, OR: [
      { source: "apple-keyword", target: { in: app.keywords.map(term => selection.country + ":" + term) } },
      { source: "apple-public-lookup", target: listingTarget },
    ], startedAt: { gte: metricDayStart(start), lt: metricDayStart(shiftMetricDay(selection.day, 1)), lte: now } }, take: ATTEMPT_LIMIT + 1, orderBy: [{ startedAt: "desc" }, { id: "desc" }] }),
  ]);
  if (attempts.length > ATTEMPT_LIMIT) throw new Error("검색 순위 수집 시도가 조회 한도를 넘었습니다. 기간을 줄여 다시 조회하세요.");
  return { apps, selection, today: metricDayOf(now), app, history: buildKeywordHistory(app, selection, [...prior, ...observations], attempts, now, listingTarget) };
}
