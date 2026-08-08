import { BigQuery } from "@google-cloud/bigquery";
import { env } from "@/lib/env";
import type { Ga4Target } from "@/lib/ga4/datasets";
import type { Ga4BreakdownRow } from "@/lib/ga4/metric-shapes";

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

/**
 * job location 결정(순수). 우선순위: override > 캐시 > dataset 메타 조회값.
 * 셋 다 없으면 US 로 임의 폴백하지 않고 에러 — 비US 리전 데이터셋을 US 로 잘못
 * 조회하는 회귀를 막는다.
 */
export function decideLocation(opts: {
  override?: string;
  cached?: string;
  fetched?: string | null;
}): string {
  const o = opts.override?.trim();
  if (o) return o;
  if (opts.cached) return opts.cached;
  if (opts.fetched) return opts.fetched;
  throw new Error("dataset location 을 확인할 수 없음(메타에 location 없음/권한 부족)");
}

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

// 쿼리 폭주 과금 차단. 이 상한(bytes)을 넘게 스캔하는 job 은 BigQuery 가 실패시켜
// 비용을 원천 차단한다. 현재 게임당 일 스캔 ~2.5MB 이므로 기본 2GiB 는 폭주(파티션
// 프루닝 실패/데이터 폭증/코드 버그)만 걸러내고 정상 쿼리는 영향받지 않는다.
const MAX_BYTES_BILLED = env.optional("GA4_MAX_BYTES_BILLED", String(2 * 1024 ** 3));

export async function runQuery<T>(project: string, dataset: string, sql: string): Promise<T[]> {
  const location = await resolveLocation(project, dataset);
  const [rows] = await clientFor(project).query({
    query: sql,
    location,
    maximumBytesBilled: MAX_BYTES_BILLED,
  });
  return rows as T[];
}

// 콘텐츠 지표 소스 어댑터(ga4/content-source.ts)가 재사용하는 공개 러너. 인증 클라이언트
// + job location + maximumBytesBilled 방어를 이 파일에 가두고, SQL 은 호출부가 조립한다.
export async function runGa4Query<T>(target: Ga4Target, sql: string): Promise<T[]> {
  return runQuery<T>(target.firebaseProject, target.dataset, sql);
}

export function num(v: unknown): number {
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
  adCtaUsers: number;
  adCtaImpressions: number;
  adCompletedUsers: number;
  adCompletions: number;
  networkAdUsers: number;
  networkAdImpressions: number;
}

export interface Ga4CohortRow {
  date: string; // cohort_day "YYYY-MM-DD"
  newUsers: number;
  d1Pct: number | null;
  d3Pct: number | null;
  d7Pct: number | null;
}

export function mapDailyActivityRow(r: Record<string, unknown>): Ga4DailyRow {
  return {
    date: String(r.date),
    dau: num(r.dau),
    newUsers: num(r.new_users),
    engagedUsers: num(r.engaged_users),
    avgEngageSec: numOrNull(r.avg_engage_sec),
    adEventUsers: num(r.ad_users),
    adImpressions: num(r.broad_ad_events),
    adCtaUsers: num(r.ad_cta_users),
    adCtaImpressions: num(r.ad_cta_impressions),
    adCompletedUsers: num(r.ad_completed_users),
    adCompletions: num(r.ad_completions),
    networkAdUsers: num(r.network_ad_users),
    networkAdImpressions: num(r.network_ad_impressions),
  };
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
      COUNTIF(REGEXP_CONTAINS(event_name, ${AD_EVENT_RE})) AS broad_ad_events,
      COUNT(DISTINCT IF(event_name = 'ad_reward_impression', user_pseudo_id, NULL)) AS ad_cta_users,
      COUNTIF(event_name = 'ad_reward_impression') AS ad_cta_impressions,
      COUNT(DISTINCT IF(event_name = 'ad_reward_completed', user_pseudo_id, NULL)) AS ad_completed_users,
      COUNTIF(event_name = 'ad_reward_completed') AS ad_completions,
      COUNT(DISTINCT IF(event_name = 'ad_impression', user_pseudo_id, NULL)) AS network_ad_users,
      COUNTIF(event_name = 'ad_impression') AS network_ad_impressions
    FROM ${from}
    WHERE _TABLE_SUFFIX BETWEEN '${start}' AND '${end}'
    GROUP BY date
    ORDER BY date`;
  const rows = await runQuery<Record<string, unknown>>(target.firebaseProject, target.dataset, sql);
  return rows.map(mapDailyActivityRow);
}

// 광고/수익 진단 결과(앱×윈도우 합계 1행). AdMob↔GA4 연동 + 노출수준 수익 export
// 활성 여부를 실데이터로 확인하기 위한 프로브 전용 타입. 지표 상시수집에는 쓰지 않는다.
export interface Ga4AdProbe {
  /** 표준 이벤트 ad_impression 수(실제 노출). */
  adImpressions: number;
  /** ad_format='rewarded' 노출 수(실제 시청한 리워드 광고). */
  rewardedImpressions: number;
  /** value 파라미터가 채워진 ad_impression 수(수익 export 동작 여부). */
  impressionsWithValue: number;
  /** ad_impression.value 합계(추정 광고수익). value 부재 시 0. */
  estRevenue: number;
  /** ad_impression.currency 고유값(쉼표 결합). 없으면 null. */
  currencies: string | null;
  /** legacy 광의 광고 이벤트 카운트(마이그레이션 비교용, 노출 지표로 표시하지 않음). */
  broadAdEvents: number;
}

// GA4 ad_impression 의 value 는 통상 double, 드물게 int 로 온다 → COALESCE.
const AD_VALUE = "COALESCE((SELECT COALESCE(value.double_value, value.int_value) FROM UNNEST(event_params) WHERE key = 'value'), 0)";
const AD_FORMAT = "(SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'ad_format')";
const AD_CURRENCY = "(SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'currency')";

/**
 * 광고/수익 진단. ad_impression 이벤트와 노출수준 수익(value)이 실제로 export 되는지
 * 실데이터로 확인한다. start/end 는 "YYYYMMDD".
 */
export async function queryAdProbe(
  target: Ga4Target,
  start: string,
  end: string,
): Promise<Ga4AdProbe> {
  const from = `\`${target.firebaseProject}.${target.dataset}.events_*\``;
  const sql = `
    SELECT
      COUNTIF(event_name = 'ad_impression') AS ad_impressions,
      COUNTIF(event_name = 'ad_impression' AND ${AD_FORMAT} = 'rewarded') AS rewarded_impressions,
      COUNTIF(event_name = 'ad_impression' AND ${AD_VALUE} > 0) AS impressions_with_value,
      -- est_revenue 는 impressions_with_value 와 반드시 같은 부분집합(value>0)만 합산해야
      -- 두 지표가 모순되지 않는다. value 없는 노출(COALESCE→0)까지 포함하지 않도록 조건 일치.
      ROUND(SUM(IF(event_name = 'ad_impression' AND ${AD_VALUE} > 0, ${AD_VALUE}, 0)), 4) AS est_revenue,
      -- currency 는 value>0 인 노출에서만 수집(수익 없는 빈 currency 문자열 혼입 방지).
      STRING_AGG(DISTINCT IF(event_name = 'ad_impression' AND ${AD_VALUE} > 0 AND ${AD_CURRENCY} != '', ${AD_CURRENCY}, NULL)) AS currencies,
      COUNTIF(REGEXP_CONTAINS(event_name, ${AD_EVENT_RE})) AS broad_ad_events
    FROM ${from}
    WHERE _TABLE_SUFFIX BETWEEN '${start}' AND '${end}'`;
  const rows = await runQuery<Record<string, unknown>>(target.firebaseProject, target.dataset, sql);
  return mapAdProbeRow(rows[0] ?? {});
}

/**
 * BigQuery 응답 1행 → Ga4AdProbe 매핑(순수). SQL 조립과 분리해 회귀 테스트 가능하게 한다.
 * currencies 는 빈 문자열/공백을 null 로 정규화(UI '추정수익' 셀 공백 표시 방지).
 */
export function mapAdProbeRow(r: Record<string, unknown>): Ga4AdProbe {
  const currencies = r.currencies != null ? String(r.currencies).trim() : "";
  return {
    adImpressions: num(r.ad_impressions),
    rewardedImpressions: num(r.rewarded_impressions),
    impressionsWithValue: num(r.impressions_with_value),
    estRevenue: num(r.est_revenue),
    currencies: currencies || null,
    broadAdEvents: num(r.broad_ad_events),
  };
}

/**
 * 날짜×차원별 DAU 분해(플랫폼/국가/기기카테고리/OS버전). start/end 는 "YYYYMMDD".
 * events 를 한 번 스캔(CTE)해 4개 차원을 UNION ALL 로 집계한다. DAU 는 차원별 고유
 * user_pseudo_id 라 차원마다 GROUP BY 가 필요하다(단순 합산 불가).
 */
export function buildDailyBreakdownsSql(
  target: Ga4Target,
  start: string,
  end: string,
): string {
  const from = `\`${target.firebaseProject}.${target.dataset}.events_*\``;
  return `
    WITH base AS (
      SELECT
        FORMAT_DATE('%Y-%m-%d', PARSE_DATE('%Y%m%d', event_date)) AS date,
        user_pseudo_id AS uid,
        COALESCE(
          NULLIF(UPPER((SELECT ep.value.string_value
            FROM UNNEST(event_params) ep WHERE ep.key = 'platform')), ''),
          NULLIF(UPPER(platform), ''),
          '(unknown)'
        ) AS platform,
        IFNULL(NULLIF(geo.country, ''), '(unknown)') AS country,
        IFNULL(NULLIF(device.category, ''), '(unknown)') AS device_cat,
        IFNULL(NULLIF(TRIM(CONCAT(IFNULL(device.operating_system, ''), ' ', IFNULL(device.operating_system_version, ''))), ''), '(unknown)') AS os_dim
      FROM ${from}
      WHERE user_pseudo_id IS NOT NULL AND _TABLE_SUFFIX BETWEEN '${start}' AND '${end}'
    )
    -- 각 분기의 val(3번째 컬럼)은 base 의 정규화된 단일 컬럼 → SELECT/GROUP BY 식이 항상 일치.
    SELECT date, 'platform' AS dim, platform AS val, COUNT(DISTINCT uid) AS dau FROM base GROUP BY 1, 3
    UNION ALL SELECT date, 'country', country, COUNT(DISTINCT uid) FROM base GROUP BY 1, 3
    UNION ALL SELECT date, 'device', device_cat, COUNT(DISTINCT uid) FROM base GROUP BY 1, 3
    UNION ALL SELECT date, 'os', os_dim, COUNT(DISTINCT uid) FROM base GROUP BY 1, 3`;
}

export async function queryDailyBreakdowns(
  target: Ga4Target,
  start: string,
  end: string,
): Promise<Ga4BreakdownRow[]> {
  const sql = buildDailyBreakdownsSql(target, start, end);
  const rows = await runQuery<Record<string, unknown>>(target.firebaseProject, target.dataset, sql);
  return rows.map((r) => ({
    date: String(r.date),
    dim: String(r.dim),
    val: String(r.val),
    dau: num(r.dau),
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
