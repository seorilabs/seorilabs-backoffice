import {
  assertIdent,
  hasMarket,
  specEvents,
  type AppContentSpec,
  type ContentAgg,
  type ContentGroupSpec,
  type ContentPredicate,
} from "@/lib/analytics/content-spec";
import {
  MARKET_ALL,
  type ContentMetricByMarket,
  type ContentMetricSnapshot,
  type ContentMetricValue,
} from "@/lib/analytics/content-source";

// 컨텐츠 지표 BigQuery SQL 조립 + 응답 피벗의 순수 로직(무거운 의존성 없음).
// ga4-content-source.ts(BigQuery 구현)와 테스트가 공유한다.
//
// 한 번의 events_* 스캔(base CTE)으로 flat 지표/분포/그룹/총계를 UNION ALL 로 뽑는다.
// 마켓 분해 스펙은 base 에 market 컬럼을 두고 각 파트를 GROUPING SETS 로 마켓별 + 통합('all')
// 두 레벨로 집계한다(고유사용자 distinct 가 통합에서도 정확). 미선언 스펙은 'all' 단일.

const DEFAULT_TOP_N = 8;
const DEFAULT_GROUP_TOP_N = 20;
const GROUP_SEP = "|"; // metric 컬럼에 "<groupKey>|<metricKey>" 인코딩(둘 다 ident → 안전 구분자)

/** UNION ALL 통합 응답 한 행. a/b 는 종류별 의미가 다르다. */
export interface ContentSqlRow {
  date: string; // "YYYY-MM-DD"
  market: string; // 'all' 또는 마켓 key
  kind: string; // 'metric' | 'dist' | 'group' | 'total'
  metric: string; // metric/dist key, group 은 "<groupKey>|<metricKey>", total 은 ''
  val: string; // dist/group 값, 그 외 ''
  a: number; // count/dist: 이벤트수, sum/avg: 집계값, users: 고유수, total: 총이벤트수
  b: number; // count: 고유사용자수, 그 외 0
}

// 스펙 값(predicate/platformMap)은 개발자 정의지만 SQL 리터럴로 들어가므로 charset 을 강제.
const VALUE_RE = /^[a-zA-Z0-9_.\-]{1,64}$/;
function assertValue(value: string, what: string): string {
  if (!VALUE_RE.test(value)) {
    throw new Error(`컨텐츠 스펙 값 규격 위반(${what}): ${JSON.stringify(value)}`);
  }
  return value;
}

// event_param 문자열 값 추출(string→int→double 순 coalesce). 미존재는 NULL.
function rawStringParam(param: string): string {
  const p = assertIdent(param, "param");
  return (
    `(SELECT COALESCE(ep.value.string_value, CAST(ep.value.int_value AS STRING), ` +
    `CAST(ep.value.double_value AS STRING)) FROM UNNEST(event_params) ep WHERE ep.key = '${p}')`
  );
}

// event_param 수치 값 추출(double→int 순 coalesce). 미존재는 NULL → AVG/SUM 이 무시.
function numberParam(param: string): string {
  const p = assertIdent(param, "param");
  return (
    `(SELECT COALESCE(ep.value.double_value, CAST(ep.value.int_value AS FLOAT64)) ` +
    `FROM UNNEST(event_params) ep WHERE ep.key = '${p}')`
  );
}

const OP_SQL: Record<Exclude<ContentPredicate["op"], "truthy" | "ne_or_unset">, string> = {
  eq: "=",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

// 불리언 truthy 검사. web/RN Firebase SDK 가 string 'true'/'1' 또는 int 1 로 export 하는
// 두 형식을 모두 참으로 인정한다(둘 다 없으면 FALSE).
function truthyExpr(param: string): string {
  const p = assertIdent(param, "predicate.param");
  return (
    `COALESCE(` +
    `(SELECT LOWER(ep.value.string_value) IN ('true', '1') FROM UNNEST(event_params) ep WHERE ep.key = '${p}'), ` +
    `(SELECT ep.value.int_value = 1 FROM UNNEST(event_params) ep WHERE ep.key = '${p}'), ` +
    `FALSE)`
  );
}

/** predicate → SQL 조건절(문자열/숫자 param 비교, 또는 불리언 truthy). */
function predicateSql(p: ContentPredicate): string {
  if (p.op === "truthy") return truthyExpr(p.param);
  if (p.value == null) {
    throw new Error(`predicate op '${p.op}' 는 value 필수: ${JSON.stringify(p)}`);
  }
  if (p.op === "ne_or_unset") {
    const value = String(p.value);
    const v = assertValue(value, "predicate.value");
    return `COALESCE(${rawStringParam(p.param)}, '') != '${v}'`;
  }
  const op = OP_SQL[p.op];
  if (typeof p.value === "number") {
    return `${numberParam(p.param)} ${op} ${p.value}`;
  }
  const v = assertValue(p.value, "predicate.value");
  return `${rawStringParam(p.param)} ${op} '${v}'`;
}

/** event(문자열/배열) → event_name 필터절. 단일은 '=', 다중은 IN. */
function eventFilter(event: string | string[]): string {
  const list = (Array.isArray(event) ? event : [event]).map((e) => `'${assertIdent(e, "event")}'`);
  return list.length === 1 ? `event_name = ${list[0]}` : `event_name IN (${list.join(", ")})`;
}

/** where 필터들을 AND 로 결합한 추가 조건(없으면 ''). */
function whereClause(where?: ContentPredicate[]): string {
  if (!where || where.length === 0) return "";
  return " AND " + where.map(predicateSql).join(" AND ");
}

/** market 해석 식. param(우선) → platformMap 폴백 → 'unknown'. */
function marketExpr(spec: AppContentSpec): string {
  const m = spec.market!;
  const parts: string[] = [];
  if (m.param) parts.push(`NULLIF(${rawStringParam(m.param)}, '')`);
  const pm = m.platformMap;
  if (pm) {
    const cases: string[] = [];
    if (pm.android) cases.push(`WHEN 'ANDROID' THEN '${assertValue(pm.android, "platformMap.android")}'`);
    if (pm.ios) cases.push(`WHEN 'IOS' THEN '${assertValue(pm.ios, "platformMap.ios")}'`);
    if (pm.web) cases.push(`WHEN 'WEB' THEN '${assertValue(pm.web, "platformMap.web")}'`);
    if (cases.length > 0) parts.push(`CASE UPPER(IFNULL(platform, '')) ${cases.join(" ")} ELSE NULL END`);
  }
  parts.push(`'unknown'`);
  return `COALESCE(${parts.join(", ")})`;
}

/** agg 별 (a, b) 집계식. count 만 b(고유사용자)를 채운다. */
function aggExprs(agg: ContentAgg, param: string | undefined, round: number): { a: string; b: string } {
  switch (agg) {
    case "count":
      return { a: "CAST(COUNT(*) AS FLOAT64)", b: "CAST(COUNT(DISTINCT uid) AS FLOAT64)" };
    case "users":
      return { a: "CAST(COUNT(DISTINCT uid) AS FLOAT64)", b: "0.0" };
    case "sum":
      return { a: `ROUND(SUM(nval), ${round})`, b: "0.0" };
    case "avg":
      return { a: `ROUND(AVG(nval), ${round})`, b: "0.0" };
  }
}

interface PartOpts {
  kind: "metric" | "dist" | "group" | "total";
  metric: string; // 리터럴(이미 검증된 key/인코딩). total 은 ''
  event?: string | string[]; // total 은 생략(base 전체)
  where?: ContentPredicate[];
  agg: ContentAgg;
  param?: string; // sum/avg 수치 param
  round?: number;
  dimParam?: string; // dist/group 의 그룹 키 param(값 → val 컬럼)
}

/** 한 UNION ALL 파트 조립. inner 서브쿼리에서 dim/nval 을 계산하고 outer 에서 집계·GROUPING. */
function buildPart(spec: AppContentSpec, o: PartOpts): string {
  const mkt = hasMarket(spec);
  const round = Number.isFinite(o.round) ? Number(o.round) : 1;
  const { a, b } = aggExprs(o.agg, o.param, round);
  const marketSel = mkt ? "IFNULL(market, 'all')" : "'all'";
  const valSel = o.dimParam ? "dim" : "''";

  // inner: base 를 이벤트/조건으로 필터하고 dim/nval 을 뽑는다.
  const innerCols = ["date", "uid"];
  if (mkt) innerCols.push("market");
  if (o.dimParam) innerCols.push(`IFNULL(${rawStringParam(o.dimParam)}, '(unset)') AS dim`);
  if (o.agg === "sum" || o.agg === "avg") {
    if (!o.param) throw new Error(`sum/avg metric 은 param 필수: ${o.metric}`);
    innerCols.push(`${numberParam(o.param)} AS nval`);
  }
  const innerWhere =
    o.kind === "total" ? "" : ` WHERE ${eventFilter(o.event!)}${whereClause(o.where)}`;
  const inner = `SELECT ${innerCols.join(", ")} FROM base${innerWhere}`;

  // outer GROUP BY: 마켓 분해면 GROUPING SETS 로 마켓별 + 통합(market NULL) 두 레벨.
  const dimGroup = o.dimParam ? ", dim" : "";
  const groupBy = mkt
    ? `GROUPING SETS ((date, market${dimGroup}), (date${dimGroup}))`
    : `date${dimGroup}`;

  return (
    `SELECT date, ${marketSel} AS market, '${o.kind}' AS kind, '${o.metric}' AS metric, ` +
    `${valSel} AS val, ${a} AS a, ${b} AS b FROM (${inner}) GROUP BY ${groupBy}`
  );
}

/**
 * 컨텐츠 지표 집계 SQL(순수 조립). events 를 base CTE 로 한 번 스캔하고 flat 지표/분포/
 * 그룹/총계를 UNION ALL 로 뽑는다. start/end 는 "YYYYMMDD". fromExpr 는 백틱 포함된
 * `proj.dataset.events_*` 표현식.
 */
export function buildContentSql(
  spec: AppContentSpec,
  fromExpr: string,
  start: string,
  end: string,
): string {
  const mkt = hasMarket(spec);
  const events = specEvents(spec).map((e) => `'${assertIdent(e, "event")}'`);
  const eventList = events.length > 0 ? events.join(", ") : "''";
  const parts: string[] = [];

  for (const m of spec.metrics ?? []) {
    parts.push(buildPart(spec, { kind: "metric", metric: assertIdent(m.key, "metric.key"), event: m.event, where: m.where, agg: m.agg, param: m.param, round: m.round }));
  }
  for (const d of spec.distributions ?? []) {
    parts.push(buildPart(spec, { kind: "dist", metric: assertIdent(d.key, "distribution.key"), event: d.event, where: d.where, agg: "count", dimParam: d.param }));
  }
  for (const g of spec.groups ?? []) {
    const gk = assertIdent(g.key, "group.key");
    for (const m of g.metrics) {
      const mk = assertIdent(m.key, "group.metric.key");
      parts.push(buildPart(spec, { kind: "group", metric: `${gk}${GROUP_SEP}${mk}`, event: m.event, where: m.where, agg: m.agg, param: m.param, round: m.round, dimParam: g.param }));
    }
  }
  // 총 스펙 이벤트 수(수집 유효성 판단용). base 는 스펙 이벤트로 이미 필터됨.
  parts.push(buildPart(spec, { kind: "total", metric: "", agg: "count" }));

  const marketCol = mkt ? `,\n    ${marketExpr(spec)} AS market` : "";
  return (
    `WITH base AS (\n` +
    `  SELECT\n` +
    `    FORMAT_DATE('%Y-%m-%d', PARSE_DATE('%Y%m%d', event_date)) AS date,\n` +
    `    event_name, user_pseudo_id AS uid, event_params${marketCol}\n` +
    `  FROM ${fromExpr}\n` +
    `  WHERE user_pseudo_id IS NOT NULL AND _TABLE_SUFFIX BETWEEN '${start}' AND '${end}'\n` +
    `    AND event_name IN (${eventList})\n` +
    `)\n` +
    parts.join("\nUNION ALL\n")
  );
}

// ── 응답 피벗 ────────────────────────────────────────────────────────────────

/** metric key → agg 룩업(값 기본치/타입 결정용). */
function metricAggMap(spec: AppContentSpec): Map<string, ContentAgg> {
  const map = new Map<string, ContentAgg>();
  for (const m of spec.metrics ?? []) map.set(m.key, m.agg);
  return map;
}
function groupMetricAggMap(g: ContentGroupSpec): Map<string, ContentAgg> {
  const map = new Map<string, ContentAgg>();
  for (const m of g.metrics) map.set(m.key, m.agg);
  return map;
}

/** agg 기본 지표값(count/users=0, sum/avg=null). */
function defaultValue(agg: ContentAgg): ContentMetricValue {
  return agg === "count" ? { value: 0, users: 0 } : agg === "users" ? { value: 0 } : { value: null };
}

/** 스펙 기준 빈 스냅샷(모든 flat key 존재하도록 초기화). 그룹 값은 데이터에서 채운다. */
function emptySnapshot(spec: AppContentSpec, aggs: Map<string, ContentAgg>): ContentMetricSnapshot {
  const metrics: Record<string, ContentMetricValue> = {};
  for (const m of spec.metrics ?? []) metrics[m.key] = defaultValue(m.agg);
  const distributions: Record<string, ContentMetricSnapshot["distributions"][string]> = {};
  for (const d of spec.distributions ?? []) distributions[d.key] = [];
  const groups: ContentMetricSnapshot["groups"] = {};
  for (const g of spec.groups ?? []) groups[g.key] = {};
  void aggs;
  return { metrics, distributions, groups, totalEvents: 0 };
}

/** distribution key → topN. */
function distTopN(spec: AppContentSpec, key: string): number {
  const d = (spec.distributions ?? []).find((x) => x.key === key);
  return d?.topN && d.topN > 0 ? d.topN : DEFAULT_TOP_N;
}

/**
 * 통합 행들을 market → date → 스냅샷으로 피벗(순수). 분포는 count 내림차순(동률 key
 * 코드포인트순) 상위 N. 마켓 미선언 스펙은 MARKET_ALL 키 하나만 나온다.
 *
 * 스펙 이벤트가 하루에 하나라도 있으면 'total' 행이 나와 그 (마켓×날짜) 스냅샷이 생성되고,
 * 각 metric 의 부분 zero 는 emptySnapshot 초기값으로 표현된다. 이벤트가 아예 0건인
 * (마켓×날짜)는 결과에서 빠진다(빈 스냅샷 upsert 안 함) — 의도된 동작.
 */
export function mapContentRows(rows: ContentSqlRow[], spec: AppContentSpec): ContentMetricByMarket {
  const flatAggs = metricAggMap(spec);
  const groupAggs = new Map<string, Map<string, ContentAgg>>();
  for (const g of spec.groups ?? []) groupAggs.set(g.key, groupMetricAggMap(g));

  const out: ContentMetricByMarket = {};
  const ensure = (market: string, date: string): ContentMetricSnapshot => {
    const byDate = (out[market] ??= {});
    return (byDate[date] ??= emptySnapshot(spec, flatAggs));
  };

  for (const r of rows) {
    const snap = ensure(r.market || MARKET_ALL, r.date);
    if (r.kind === "dist") {
      (snap.distributions[r.metric] ??= []).push({ k: r.val, count: Math.round(r.a), users: Math.round(r.b) });
    } else if (r.kind === "metric") {
      snap.metrics[r.metric] = toValue(r, flatAggs.get(r.metric));
    } else if (r.kind === "group") {
      const [gk, mk] = r.metric.split(GROUP_SEP);
      const gval = (snap.groups[gk] ??= {});
      const row = (gval[r.val] ??= {});
      row[mk] = toValue(r, groupAggs.get(gk)?.get(mk));
    } else if (r.kind === "total") {
      snap.totalEvents = Math.round(r.a);
    }
  }

  for (const byDate of Object.values(out)) {
    for (const snap of Object.values(byDate)) {
      for (const key of Object.keys(snap.distributions)) {
        snap.distributions[key] = snap.distributions[key]
          .sort((x, y) => y.count - x.count || (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))
          .slice(0, distTopN(spec, key));
      }
    }
  }
  return out;
}

/** SQL 행 → 지표값. count 는 정수+users, users 는 정수, sum/avg 는 원값(이미 ROUND). */
function toValue(r: ContentSqlRow, agg: ContentAgg | undefined): ContentMetricValue {
  if (agg === "count") return { value: Math.round(r.a), users: Math.round(r.b) };
  if (agg === "users") return { value: Math.round(r.a) };
  return { value: r.a };
}

export { DEFAULT_GROUP_TOP_N };
