import { BigQuery } from "@google-cloud/bigquery";
import { env } from "@/lib/env";
import { decideLocation } from "@/lib/ga4/bigquery";
import type { Ga4Target } from "@/lib/ga4/datasets";
import {
  num,
  type AdPlacementDailyRow,
  type AreaDailyRow,
  type CropDailyRow,
  type FunnelDailyRow,
} from "@/lib/ga4/content-shapes";

// happy-farm 콘텐츠 세부 지표를 GA4 export(events_*)에서 작물/구역/기능퍼널/광고
// placement 단위로 집계한다. 지표 정의는 happy-farm docs/04-work/content-analytics.md.
//
// 격리 메모: 여러 게임 지표 작업이 동시에 진행되므로 공통 bigquery.ts 를 수정하지
// 않는다(pure `decideLocation`만 재사용). 클라이언트/러너는 이 모듈에 자체적으로 둔다.
// 과금 안전상 동일한 maximumBytesBilled 상한을 적용한다.

const clients = new Map<string, BigQuery>();

function clientFor(project: string): BigQuery {
  const cached = clients.get(project);
  if (cached) return cached;
  const raw = env.ga4SaKeyJson();
  if (!raw) throw new Error("GA4_SA_KEY_JSON 미설정 — BigQuery 조회 불가");
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("GA4_SA_KEY_JSON 파싱 실패(JSON 형식 아님)");
  }
  const bq = new BigQuery({ projectId: project, credentials });
  clients.set(project, bq);
  return bq;
}

const locationCache = new Map<string, string>();

async function resolveLocation(project: string, dataset: string): Promise<string> {
  const override = env.optional("GA4_BQ_LOCATION").trim();
  if (override) return override;
  const key = `${project}.${dataset}`;
  const cached = locationCache.get(key);
  if (cached) return cached;
  const [meta] = await clientFor(project).dataset(dataset).getMetadata();
  const loc = decideLocation({ fetched: (meta?.location as string) ?? null });
  locationCache.set(key, loc);
  return loc;
}

const MAX_BYTES_BILLED = env.optional("GA4_MAX_BYTES_BILLED", String(2 * 1024 ** 3));

async function runQuery(project: string, dataset: string, sql: string): Promise<Record<string, unknown>[]> {
  const location = await resolveLocation(project, dataset);
  const [rows] = await clientFor(project).query({
    query: sql,
    location,
    maximumBytesBilled: MAX_BYTES_BILLED,
  });
  return rows as Record<string, unknown>[];
}

// event_params 에서 문자열/숫자 파라미터를 평탄화하는 스칼라 서브쿼리 조각.
const P_STR = (key: string) =>
  `(SELECT ep.value.string_value FROM UNNEST(event_params) ep WHERE ep.key = '${key}')`;
const P_NUM = (key: string) =>
  `(SELECT COALESCE(ep.value.double_value, ep.value.int_value) FROM UNNEST(event_params) ep WHERE ep.key = '${key}')`;
const P_INT = (key: string) =>
  `(SELECT ep.value.int_value FROM UNNEST(event_params) ep WHERE ep.key = '${key}')`;

const dateExpr = "FORMAT_DATE('%Y-%m-%d', PARSE_DATE('%Y%m%d', event_date))";
const suffix = (start: string, end: string) => `_TABLE_SUFFIX BETWEEN '${start}' AND '${end}'`;

/** 작물×일자 집계. start/end 는 "YYYYMMDD". */
export async function queryCropDaily(
  target: Ga4Target,
  start: string,
  end: string,
): Promise<CropDailyRow[]> {
  const from = `\`${target.firebaseProject}.${target.dataset}.events_*\``;
  const sql = `
    WITH ev AS (
      SELECT
        ${dateExpr} AS date,
        event_name,
        user_pseudo_id AS uid,
        ${P_STR("crop")} AS crop,
        ${P_NUM("revenue")} AS revenue,
        ${P_INT("is_first_crop_harvest")} AS is_first_crop_harvest
      FROM ${from}
      WHERE ${suffix(start, end)}
        AND event_name IN ('seed_selected','first_seed_selected','crop_planted','crop_ready','crop_harvested','crop_of_the_day_harvested')
    )
    SELECT
      date, crop,
      COUNTIF(event_name = 'crop_planted') AS planted,
      COUNTIF(event_name = 'crop_ready') AS ready,
      COUNTIF(event_name = 'crop_harvested') AS harvested,
      COUNTIF(event_name IN ('seed_selected','first_seed_selected')) AS seed_selected,
      COUNTIF(event_name = 'crop_harvested' AND is_first_crop_harvest = 1) AS first_harvests,
      COUNTIF(event_name = 'crop_of_the_day_harvested') AS cotd_harvests,
      COUNT(DISTINCT IF(event_name = 'crop_harvested', uid, NULL)) AS harvesters,
      SUM(IF(event_name = 'crop_harvested', COALESCE(revenue, 0), 0)) AS revenue
    FROM ev
    WHERE crop IS NOT NULL
    GROUP BY date, crop`;
  const rows = await runQuery(target.firebaseProject, target.dataset, sql);
  return rows.map((r) => ({
    date: String(r.date),
    crop: String(r.crop),
    planted: num(r.planted),
    ready: num(r.ready),
    harvested: num(r.harvested),
    seedSelected: num(r.seed_selected),
    firstHarvests: num(r.first_harvests),
    cotdHarvests: num(r.cotd_harvests),
    harvesters: num(r.harvesters),
    revenue: num(r.revenue),
  }));
}

/** 구역×일자 집계. */
export async function queryAreaDaily(
  target: Ga4Target,
  start: string,
  end: string,
): Promise<AreaDailyRow[]> {
  const from = `\`${target.firebaseProject}.${target.dataset}.events_*\``;
  const sql = `
    WITH ev AS (
      SELECT
        ${dateExpr} AS date,
        event_name,
        ${P_STR("area")} AS area,
        ${P_NUM("cost")} AS cost
      FROM ${from}
      WHERE ${suffix(start, end)}
        AND event_name IN ('area_unlock_clicked','area_unlocked','crop_planted','crop_harvested')
    )
    SELECT
      date, area,
      COUNTIF(event_name = 'area_unlock_clicked') AS unlock_clicked,
      COUNTIF(event_name = 'area_unlocked') AS unlocked,
      COUNTIF(event_name = 'crop_planted') AS planted,
      COUNTIF(event_name = 'crop_harvested') AS harvested,
      SUM(IF(event_name = 'area_unlocked', COALESCE(cost, 0), 0)) AS unlock_cost_sum
    FROM ev
    WHERE area IS NOT NULL
    GROUP BY date, area`;
  const rows = await runQuery(target.firebaseProject, target.dataset, sql);
  return rows.map((r) => ({
    date: String(r.date),
    area: String(r.area),
    unlockClicked: num(r.unlock_clicked),
    unlocked: num(r.unlocked),
    planted: num(r.planted),
    harvested: num(r.harvested),
    unlockCostSum: num(r.unlock_cost_sum),
  }));
}

/**
 * 기능 퍼널×단계×일자 집계. 이벤트를 (funnel, step, kind)로 정규화한 뒤 집계한다.
 * onboarding 은 step_view(count)/skip(skips)/stall(stalls)/complete 를 같은 step 키로
 * 합산하고, prestige/research/collection 은 발생 수(count)로 집계한다.
 */
export async function queryFunnelDaily(
  target: Ga4Target,
  start: string,
  end: string,
): Promise<FunnelDailyRow[]> {
  const from = `\`${target.firebaseProject}.${target.dataset}.events_*\``;
  const sql = `
    WITH ev AS (
      SELECT
        ${dateExpr} AS date,
        event_name,
        user_pseudo_id AS uid,
        ${P_STR("step")} AS step,
        ${P_STR("skipped_step")} AS skipped_step,
        ${P_STR("node_key")} AS node_key,
        ${P_STR("reward_key")} AS reward_key
      FROM ${from}
      WHERE ${suffix(start, end)}
        AND event_name IN ('onboarding_step_view','onboarding_skip','onboarding_stall','onboarding_complete','prestige','research_node_unlocked','collection_reward_claimed')
    ),
    norm AS (
      SELECT
        date, uid,
        CASE
          WHEN event_name LIKE 'onboarding_%' THEN 'onboarding'
          WHEN event_name = 'prestige' THEN 'prestige'
          WHEN event_name = 'research_node_unlocked' THEN 'research'
          WHEN event_name = 'collection_reward_claimed' THEN 'collection'
        END AS funnel,
        CASE event_name
          WHEN 'onboarding_step_view' THEN step
          WHEN 'onboarding_stall' THEN step
          WHEN 'onboarding_skip' THEN skipped_step
          WHEN 'onboarding_complete' THEN 'complete'
          WHEN 'prestige' THEN 'prestige'
          WHEN 'research_node_unlocked' THEN node_key
          WHEN 'collection_reward_claimed' THEN reward_key
        END AS step,
        CASE event_name
          WHEN 'onboarding_skip' THEN 'skip'
          WHEN 'onboarding_stall' THEN 'stall'
          ELSE 'view'
        END AS kind
      FROM ev
    )
    SELECT
      date, funnel, step,
      COUNTIF(kind = 'view') AS count,
      COUNT(DISTINCT uid) AS users,
      COUNTIF(kind = 'skip') AS skips,
      COUNTIF(kind = 'stall') AS stalls
    FROM norm
    WHERE funnel IS NOT NULL AND step IS NOT NULL
    GROUP BY date, funnel, step`;
  const rows = await runQuery(target.firebaseProject, target.dataset, sql);
  return rows.map((r) => ({
    date: String(r.date),
    funnel: String(r.funnel),
    step: String(r.step),
    count: num(r.count),
    users: num(r.users),
    skips: num(r.skips),
    stalls: num(r.stalls),
  }));
}

/** 광고 placement×일자 집계(보상형 퍼널). 정의는 ad-analytics.md 준수. */
export async function queryAdPlacementDaily(
  target: Ga4Target,
  start: string,
  end: string,
): Promise<AdPlacementDailyRow[]> {
  const from = `\`${target.firebaseProject}.${target.dataset}.events_*\``;
  const sql = `
    WITH ev AS (
      SELECT
        ${dateExpr} AS date,
        event_name,
        ${P_STR("placement")} AS placement,
        ${P_STR("reason")} AS reason
      FROM ${from}
      WHERE ${suffix(start, end)}
        AND event_name IN ('ad_reward_impression','ad_reward_click','ad_reward_completed','ad_reward_failed','ad_limit_blocked')
    )
    SELECT
      date, placement,
      COUNTIF(event_name = 'ad_reward_impression') AS impressions,
      COUNTIF(event_name = 'ad_reward_click') AS clicks,
      COUNTIF(event_name = 'ad_reward_completed') AS completes,
      COUNTIF(event_name = 'ad_reward_failed') AS fails,
      COUNTIF(event_name = 'ad_reward_failed' AND reason = 'not_ready') AS fails_not_ready,
      COUNTIF(event_name = 'ad_limit_blocked') AS blocked
    FROM ev
    WHERE placement IS NOT NULL
    GROUP BY date, placement`;
  const rows = await runQuery(target.firebaseProject, target.dataset, sql);
  return rows.map((r) => ({
    date: String(r.date),
    placement: String(r.placement),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    completes: num(r.completes),
    fails: num(r.fails),
    failsNotReady: num(r.fails_not_ready),
    blocked: num(r.blocked),
  }));
}
