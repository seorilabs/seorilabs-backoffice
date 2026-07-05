import { BigQuery } from "@google-cloud/bigquery";
import { env } from "@/lib/env";
import type { Ga4Target } from "@/lib/ga4/datasets";

// GA4 export → BigQuery 조회. SA 키 JSON(env)으로 인증하고, 대상 게임 프로젝트에서
// job 을 실행한다(SA 는 각 프로젝트에 bigquery.dataViewer + jobUser 보유).
// events_YYYYMMDD 만 매칭하도록 _TABLE_SUFFIX 를 숫자 범위로 제한 → intraday 자동 제외.

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

// GA4 export 데이터셋 리전은 프로젝트마다 다르다(asia-northeast3/asia-southeast3 등).
// bq CLI 와 달리 Node SDK 는 job location 을 자동 감지하지 않으므로 dataset 메타에서 조회한다.
// GA4_BQ_LOCATION 이 지정되면 그 값을 강제(비상용).
const locationCache = new Map<string, string>();

async function resolveLocation(project: string, dataset: string): Promise<string> {
  const override = env.optional("GA4_BQ_LOCATION").trim();
  if (override) return override;
  const key = `${project}.${dataset}`;
  const cached = locationCache.get(key);
  if (cached) return cached;
  const [meta] = await clientFor(project).dataset(dataset).getMetadata();
  const loc = (meta?.location as string) || "US";
  locationCache.set(key, loc);
  return loc;
}

async function runQuery<T>(project: string, dataset: string, sql: string): Promise<T[]> {
  const location = await resolveLocation(project, dataset);
  const [rows] = await clientFor(project).query({ query: sql, location });
  return rows as T[];
}

function num(v: unknown): number {
  const n = typeof v === "object" && v !== null ? Number((v as { value: unknown }).value) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = num(v);
  return Number.isFinite(n) ? n : null;
}

const AD_EVENT_RE = "r'^(ad_|ait_|rewarded|interstitial)'";

export interface Ga4DailyRow {
  date: string; // "YYYY-MM-DD"
  dau: number;
  newUsers: number;
  engagedUsers: number;
  avgEngageSec: number | null;
  adEventUsers: number;
  adImpressions: number;
}

export interface Ga4CohortRow {
  date: string; // cohort_day "YYYY-MM-DD"
  newUsers: number;
  d1Pct: number | null;
  d3Pct: number | null;
  d7Pct: number | null;
}

/** 날짜별 활동 지표(DAU/신규/engagement/광고). start/end 는 "YYYYMMDD". */
export async function queryDailyActivity(
  target: Ga4Target,
  start: string,
  end: string,
): Promise<Ga4DailyRow[]> {
  const from = `\`${target.firebaseProject}.${target.dataset}.events_*\``;
  const sql = `
    SELECT
      FORMAT_DATE('%Y-%m-%d', PARSE_DATE('%Y%m%d', event_date)) AS date,
      COUNT(DISTINCT user_pseudo_id) AS dau,
      COUNTIF(event_name = 'first_visit') AS new_users,
      COUNT(DISTINCT IF(event_name = 'user_engagement', user_pseudo_id, NULL)) AS engaged_users,
      ROUND(AVG(IF(event_name = 'user_engagement',
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'engagement_time_msec'),
        NULL)) / 1000, 1) AS avg_engage_sec,
      COUNT(DISTINCT IF(REGEXP_CONTAINS(event_name, ${AD_EVENT_RE}), user_pseudo_id, NULL)) AS ad_users,
      COUNTIF(REGEXP_CONTAINS(event_name, ${AD_EVENT_RE})) AS ad_impressions
    FROM ${from}
    WHERE _TABLE_SUFFIX BETWEEN '${start}' AND '${end}'
    GROUP BY date
    ORDER BY date`;
  const rows = await runQuery<Record<string, unknown>>(target.firebaseProject, target.dataset, sql);
  return rows.map((r) => ({
    date: String(r.date),
    dau: num(r.dau),
    newUsers: num(r.new_users),
    engagedUsers: num(r.engaged_users),
    avgEngageSec: numOrNull(r.avg_engage_sec),
    adEventUsers: num(r.ad_users),
    adImpressions: num(r.ad_impressions),
  }));
}

/** 신규 코호트 잔존율(D1/D3/D7). 윈도우 내 첫 활동일을 코호트일로 근사. */
export async function queryCohortRetention(
  target: Ga4Target,
  start: string,
  end: string,
): Promise<Ga4CohortRow[]> {
  const from = `\`${target.firebaseProject}.${target.dataset}.events_*\``;
  const sql = `
    WITH activity AS (
      SELECT user_pseudo_id, PARSE_DATE('%Y%m%d', event_date) AS d
      FROM ${from}
      WHERE user_pseudo_id IS NOT NULL AND _TABLE_SUFFIX BETWEEN '${start}' AND '${end}'
      GROUP BY 1, 2
    ),
    cohort AS (SELECT user_pseudo_id, MIN(d) AS cohort_day FROM activity GROUP BY 1),
    j AS (
      SELECT c.cohort_day, DATE_DIFF(a.d, c.cohort_day, DAY) AS n, a.user_pseudo_id
      FROM activity a JOIN cohort c USING (user_pseudo_id)
    )
    SELECT
      FORMAT_DATE('%Y-%m-%d', cohort_day) AS date,
      COUNT(DISTINCT IF(n = 0, user_pseudo_id, NULL)) AS new_users,
      ROUND(100 * SAFE_DIVIDE(COUNT(DISTINCT IF(n=1,user_pseudo_id,NULL)), COUNT(DISTINCT IF(n=0,user_pseudo_id,NULL))), 1) AS d1_pct,
      ROUND(100 * SAFE_DIVIDE(COUNT(DISTINCT IF(n=3,user_pseudo_id,NULL)), COUNT(DISTINCT IF(n=0,user_pseudo_id,NULL))), 1) AS d3_pct,
      ROUND(100 * SAFE_DIVIDE(COUNT(DISTINCT IF(n=7,user_pseudo_id,NULL)), COUNT(DISTINCT IF(n=0,user_pseudo_id,NULL))), 1) AS d7_pct
    FROM j
    GROUP BY date
    ORDER BY date`;
  const rows = await runQuery<Record<string, unknown>>(target.firebaseProject, target.dataset, sql);
  return rows.map((r) => ({
    date: String(r.date),
    newUsers: num(r.new_users),
    d1Pct: numOrNull(r.d1_pct),
    d3Pct: numOrNull(r.d3_pct),
    d7Pct: numOrNull(r.d7_pct),
  }));
}
