import { resolveGa4Target, type Ga4Target } from "@/lib/ga4/datasets";
import { runGa4Query } from "@/lib/ga4/bigquery";
import {
  marketOf,
  type FoamContentSource,
  type ContentSourceApp,
  type ContentDateWindow,
  type LevelMetricRow,
  type MonetizationRow,
  type MissionRow,
  type EconomyRow,
  type Market,
} from "@/lib/analytics/foam-content-shapes";

// GA4 export → BigQuery 콘텐츠 지표 소스. product-core 의 콘텐츠 이벤트 카탈로그
// (content_events.gd)와 1:1 로 맞춰 이벤트 파라미터를 집계한다.
//
// 모든 콘텐츠 이벤트 파라미터는 게임에서 문자열로 전송되므로(str()) string_value 로
// 읽고 숫자는 SAFE_CAST 한다. platform 은 ANDROID/IOS/WEB 만 시장으로 인정하고
// 나머지는 제외한다(marketOf 가 최종 검증).

// events 파티션 프루닝: events_YYYYMMDD 만 매칭(intraday 자동 제외).
function from(target: Ga4Target): string {
  return `\`${target.firebaseProject}.${target.dataset}.events_*\``;
}

// string_value 로 온 콘텐츠 파라미터를 꺼내는 스칼라 서브쿼리.
const P = (key: string): string =>
  `(SELECT value.string_value FROM UNNEST(event_params) WHERE key = '${key}')`;
// 숫자 파라미터(문자열로 저장됨) → INT64.
const N = (key: string): string => `SAFE_CAST(${P(key)} AS INT64)`;

function num(v: unknown): number {
  const n =
    typeof v === "object" && v !== null ? Number((v as { value: unknown }).value) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = num(v);
  return Number.isFinite(n) ? n : null;
}

// GA4 platform → market. 미지원 platform 행은 버린다(방어적).
function toMarket(v: unknown): Market | null {
  return marketOf(String(v ?? ""));
}

function targetFor(app: ContentSourceApp): Ga4Target | null {
  return resolveGa4Target(app);
}

async function queryLevels(
  app: ContentSourceApp,
  w: ContentDateWindow,
): Promise<LevelMetricRow[]> {
  const target = targetFor(app);
  if (!target) return [];
  const sql = `
    WITH ev AS (
      SELECT
        FORMAT_DATE('%Y-%m-%d', PARSE_DATE('%Y%m%d', event_date)) AS date,
        LOWER(platform) AS market,
        event_name,
        user_pseudo_id AS uid,
        ${N("level")} AS level,
        ${N("time_sec")} AS time_sec,
        ${N("stars")} AS stars,
        ${N("coins_earned")} AS coins_earned
      FROM ${from(target)}
      WHERE _TABLE_SUFFIX BETWEEN '${w.start}' AND '${w.end}'
        AND platform IN ('ANDROID', 'IOS', 'WEB')
        AND event_name IN ('level_start', 'level_complete')
    )
    SELECT
      date, market, level,
      COUNTIF(event_name = 'level_start') AS starts,
      COUNTIF(event_name = 'level_complete') AS completes,
      COUNT(DISTINCT IF(event_name = 'level_start', uid, NULL)) AS players,
      ROUND(AVG(IF(event_name = 'level_complete', time_sec, NULL)), 1) AS avg_clear_sec,
      ROUND(AVG(IF(event_name = 'level_complete', stars, NULL)), 1) AS avg_stars,
      SUM(IF(event_name = 'level_complete', IFNULL(coins_earned, 0), 0)) AS coins_earned
    FROM ev
    WHERE level IS NOT NULL
    GROUP BY date, market, level
    ORDER BY date, market, level`;
  const rows = await runGa4Query<Record<string, unknown>>(target, sql);
  const out: LevelMetricRow[] = [];
  for (const r of rows) {
    const market = toMarket(r.market);
    if (!market) continue;
    out.push({
      date: String(r.date),
      market,
      level: num(r.level),
      starts: num(r.starts),
      completes: num(r.completes),
      players: num(r.players),
      avgClearSec: numOrNull(r.avg_clear_sec),
      avgStars: numOrNull(r.avg_stars),
      coinsEarned: num(r.coins_earned),
    });
  }
  return out;
}

async function queryMonetization(
  app: ContentSourceApp,
  w: ContentDateWindow,
): Promise<MonetizationRow[]> {
  const target = targetFor(app);
  if (!target) return [];
  const sql = `
    WITH base AS (
      SELECT
        FORMAT_DATE('%Y-%m-%d', PARSE_DATE('%Y%m%d', event_date)) AS date,
        LOWER(platform) AS market,
        user_pseudo_id AS uid,
        event_name,
        ${P("skin_id")} AS skin_id,
        ${P("tool")} AS tool,
        ${P("source")} AS source,
        ${N("cost")} AS cost
      FROM ${from(target)}
      WHERE _TABLE_SUFFIX BETWEEN '${w.start}' AND '${w.end}'
        AND platform IN ('ANDROID', 'IOS', 'WEB')
        AND event_name IN ('skin_purchase', 'upgrade_purchase', 'foam_bomb_use')
    ),
    norm AS (
      SELECT date, market, uid, 'skin' AS kind,
        IFNULL(NULLIF(skin_id, ''), '(unknown)') AS item_key,
        IFNULL(cost, 0) AS coins_spent, 0 AS ad_flag
      FROM base WHERE event_name = 'skin_purchase'
      UNION ALL
      SELECT date, market, uid, 'upgrade',
        IFNULL(NULLIF(tool, ''), '(unknown)'),
        IFNULL(cost, 0), 0
      FROM base WHERE event_name = 'upgrade_purchase'
      UNION ALL
      SELECT date, market, uid, 'foam_bomb',
        IFNULL(NULLIF(source, ''), '(unknown)'),
        IFNULL(cost, 0), IF(source = 'ad', 1, 0)
      FROM base WHERE event_name = 'foam_bomb_use'
    )
    SELECT date, market, kind, item_key,
      COUNT(*) AS count,
      COUNT(DISTINCT uid) AS users,
      SUM(coins_spent) AS coins_spent,
      SUM(ad_flag) AS ad_count
    FROM norm
    GROUP BY date, market, kind, item_key
    ORDER BY date, market, kind, item_key`;
  const rows = await runGa4Query<Record<string, unknown>>(target, sql);
  const out: MonetizationRow[] = [];
  for (const r of rows) {
    const market = toMarket(r.market);
    if (!market) continue;
    const kind = String(r.kind);
    if (kind !== "skin" && kind !== "upgrade" && kind !== "foam_bomb") continue;
    out.push({
      date: String(r.date),
      market,
      kind,
      itemKey: String(r.item_key),
      count: num(r.count),
      users: num(r.users),
      coinsSpent: num(r.coins_spent),
      adCount: num(r.ad_count),
    });
  }
  return out;
}

async function queryMissions(
  app: ContentSourceApp,
  w: ContentDateWindow,
): Promise<MissionRow[]> {
  const target = targetFor(app);
  if (!target) return [];
  const sql = `
    SELECT date, market, mission_type,
      COUNT(*) AS claims,
      COUNT(DISTINCT uid) AS users,
      SUM(IFNULL(reward, 0)) AS reward_coins
    FROM (
      SELECT
        FORMAT_DATE('%Y-%m-%d', PARSE_DATE('%Y%m%d', event_date)) AS date,
        LOWER(platform) AS market,
        user_pseudo_id AS uid,
        IFNULL(NULLIF(${P("mission_type")}, ''), '(unknown)') AS mission_type,
        ${N("reward")} AS reward
      FROM ${from(target)}
      WHERE _TABLE_SUFFIX BETWEEN '${w.start}' AND '${w.end}'
        AND platform IN ('ANDROID', 'IOS', 'WEB')
        AND event_name = 'daily_mission_claim'
    )
    GROUP BY date, market, mission_type
    ORDER BY date, market, mission_type`;
  const rows = await runGa4Query<Record<string, unknown>>(target, sql);
  const out: MissionRow[] = [];
  for (const r of rows) {
    const market = toMarket(r.market);
    if (!market) continue;
    out.push({
      date: String(r.date),
      market,
      missionType: String(r.mission_type),
      claims: num(r.claims),
      users: num(r.users),
      rewardCoins: num(r.reward_coins),
    });
  }
  return out;
}

async function queryEconomy(
  app: ContentSourceApp,
  w: ContentDateWindow,
): Promise<EconomyRow[]> {
  const target = targetFor(app);
  if (!target) return [];
  const sql = `
    WITH base AS (
      SELECT
        FORMAT_DATE('%Y-%m-%d', PARSE_DATE('%Y%m%d', event_date)) AS date,
        LOWER(platform) AS market,
        event_name,
        ${P("source")} AS source,
        ${N("coins_earned")} AS coins_earned,
        ${N("reward")} AS reward,
        ${N("cost")} AS cost
      FROM ${from(target)}
      WHERE _TABLE_SUFFIX BETWEEN '${w.start}' AND '${w.end}'
        AND platform IN ('ANDROID', 'IOS', 'WEB')
        AND event_name IN ('level_complete', 'daily_mission_claim', 'upgrade_purchase', 'skin_purchase', 'foam_bomb_use')
    )
    SELECT date, market,
      SUM(IF(event_name = 'level_complete', IFNULL(coins_earned, 0), 0)) AS coins_from_levels,
      SUM(IF(event_name = 'daily_mission_claim', IFNULL(reward, 0), 0)) AS coins_from_missions,
      SUM(IF(event_name = 'upgrade_purchase', IFNULL(cost, 0), 0)) AS coins_to_upgrades,
      SUM(IF(event_name = 'skin_purchase', IFNULL(cost, 0), 0)) AS coins_to_skins,
      SUM(IF(event_name = 'foam_bomb_use' AND source = 'coins', IFNULL(cost, 0), 0)) AS coins_to_foam_bombs,
      COUNTIF(event_name = 'foam_bomb_use' AND source = 'ad') AS foam_bomb_ad,
      COUNTIF(event_name = 'foam_bomb_use' AND source = 'coins') AS foam_bomb_coin
    FROM base
    GROUP BY date, market
    ORDER BY date, market`;
  const rows = await runGa4Query<Record<string, unknown>>(target, sql);
  const out: EconomyRow[] = [];
  for (const r of rows) {
    const market = toMarket(r.market);
    if (!market) continue;
    out.push({
      date: String(r.date),
      market,
      coinsFromLevels: num(r.coins_from_levels),
      coinsFromMissions: num(r.coins_from_missions),
      coinsToUpgrades: num(r.coins_to_upgrades),
      coinsToSkins: num(r.coins_to_skins),
      coinsToFoamBombs: num(r.coins_to_foam_bombs),
      foamBombAd: num(r.foam_bomb_ad),
      foamBombCoin: num(r.foam_bomb_coin),
    });
  }
  return out;
}

/** GA4/BigQuery 콘텐츠 지표 소스(기본 구현). 자체 지표 서버는 같은 포트를 구현해 교체. */
export const foamGa4ContentSource: FoamContentSource = {
  name: "ga4-bigquery",
  queryLevels,
  queryMonetization,
  queryMissions,
  queryEconomy,
};
