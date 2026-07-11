import {
  assertIdent,
  specEvents,
  type AppContentSpec,
} from "@/lib/analytics/content-spec";
import type {
  ContentMetricByDate,
  ContentMetricSnapshot,
} from "@/lib/analytics/content-source";

// 컨텐츠 지표 BigQuery SQL 조립 + 응답 피벗의 순수 로직(무거운 의존성 없음).
// ga4-content-source.ts(BigQuery 구현)와 테스트가 공유한다.

const DEFAULT_TOP_N = 8;

/** UNION ALL 통합 응답 한 행. a/b 는 종류별 의미가 다르다. */
export interface ContentSqlRow {
  date: string; // "YYYY-MM-DD"
  kind: string; // 'dist' | 'cnt' | 'measure' | 'total'
  metric: string; // 스펙 key(dist/cnt/measure), total 은 ''
  val: string; // dist 값, 그 외 ''
  a: number; // dist/cnt: 이벤트수, measure: 집계값, total: 총이벤트수
  b: number; // dist/cnt: 고유사용자수, 그 외 0
}

// event_param 문자열 값 추출(string→int→double 순 coalesce, 미존재는 '(unset)').
function stringParamExpr(param: string): string {
  const p = assertIdent(param, "distribution.param");
  return (
    `IFNULL((SELECT COALESCE(ep.value.string_value, CAST(ep.value.int_value AS STRING), ` +
    `CAST(ep.value.double_value AS STRING)) FROM UNNEST(event_params) ep WHERE ep.key = '${p}'), '(unset)')`
  );
}

// event_param 수치 값 추출(double→int 순 coalesce). 미존재는 NULL → AVG/SUM 이 무시.
function numberParamExpr(param: string): string {
  const p = assertIdent(param, "measure.param");
  return (
    `(SELECT COALESCE(ep.value.double_value, CAST(ep.value.int_value AS FLOAT64)) ` +
    `FROM UNNEST(event_params) ep WHERE ep.key = '${p}')`
  );
}

/**
 * 컨텐츠 지표 집계 SQL(순수 조립). events 를 한 번만 스캔(base CTE)하고 분포/카운터/
 * 수치/총계를 UNION ALL 로 뽑는다. start/end 는 "YYYYMMDD". fromExpr 는 백틱 포함된
 * `proj.dataset.events_*` 표현식.
 */
export function buildContentSql(
  spec: AppContentSpec,
  fromExpr: string,
  start: string,
  end: string,
): string {
  const events = specEvents(spec).map((e) => `'${assertIdent(e, "event")}'`);
  const eventList = events.length > 0 ? events.join(", ") : "''";
  const parts: string[] = [];

  for (const d of spec.distributions) {
    const key = assertIdent(d.key, "distribution.key");
    const ev = assertIdent(d.event, "distribution.event");
    parts.push(
      `SELECT date, 'dist' AS kind, '${key}' AS metric, ${stringParamExpr(d.param)} AS val, ` +
        `CAST(COUNT(*) AS FLOAT64) AS a, CAST(COUNT(DISTINCT uid) AS FLOAT64) AS b ` +
        `FROM base WHERE event_name = '${ev}' GROUP BY date, val`,
    );
  }
  for (const c of spec.counters) {
    const key = assertIdent(c.key, "counter.key");
    const ev = assertIdent(c.event, "counter.event");
    parts.push(
      `SELECT date, 'cnt' AS kind, '${key}' AS metric, '' AS val, ` +
        `CAST(COUNT(*) AS FLOAT64) AS a, CAST(COUNT(DISTINCT uid) AS FLOAT64) AS b ` +
        `FROM base WHERE event_name = '${ev}' GROUP BY date`,
    );
  }
  for (const m of spec.measures) {
    const key = assertIdent(m.key, "measure.key");
    const ev = assertIdent(m.event, "measure.event");
    const agg = m.agg === "sum" ? "SUM" : "AVG";
    const round = Number.isFinite(m.round) ? Number(m.round) : 1;
    parts.push(
      `SELECT date, 'measure' AS kind, '${key}' AS metric, '' AS val, ` +
        `ROUND(${agg}(${numberParamExpr(m.param)}), ${round}) AS a, 0.0 AS b ` +
        `FROM base WHERE event_name = '${ev}' GROUP BY date`,
    );
  }
  // 총 스펙 이벤트 수(수집 유효성 판단용). base 는 스펙 이벤트로 이미 필터됨.
  parts.push(`SELECT date, 'total' AS kind, '' AS metric, '' AS val, ` +
    `CAST(COUNT(*) AS FLOAT64) AS a, 0.0 AS b FROM base GROUP BY date`);

  return (
    `WITH base AS (\n` +
    `  SELECT\n` +
    `    FORMAT_DATE('%Y-%m-%d', PARSE_DATE('%Y%m%d', event_date)) AS date,\n` +
    `    event_name, user_pseudo_id AS uid, event_params\n` +
    `  FROM ${fromExpr}\n` +
    `  WHERE user_pseudo_id IS NOT NULL AND _TABLE_SUFFIX BETWEEN '${start}' AND '${end}'\n` +
    `    AND event_name IN (${eventList})\n` +
    `)\n` +
    parts.join("\nUNION ALL\n")
  );
}

/** 스펙 기준 빈 스냅샷(모든 key 존재하도록 초기화). 데이터 없는 날도 안정적 형태 유지. */
function emptySnapshot(spec: AppContentSpec): ContentMetricSnapshot {
  const distributions: Record<string, ContentMetricSnapshot["distributions"][string]> = {};
  for (const d of spec.distributions) distributions[d.key] = [];
  const counters: ContentMetricSnapshot["counters"] = {};
  for (const c of spec.counters) counters[c.key] = { count: 0, users: 0 };
  const measures: ContentMetricSnapshot["measures"] = {};
  for (const m of spec.measures) measures[m.key] = null;
  return { distributions, counters, measures, totalEvents: 0 };
}

/** distribution key → topN(스펙, 기본 8). */
function topNFor(spec: AppContentSpec, key: string): number {
  const d = spec.distributions.find((x) => x.key === key);
  return d?.topN && d.topN > 0 ? d.topN : DEFAULT_TOP_N;
}

/**
 * 통합 행들을 date → 스냅샷으로 피벗(순수). 분포는 count 내림차순(동률 key 코드포인트순)
 * 상위 N 만 남긴다. 스펙에 있는 key 는 그 날 데이터가 없어도 초기값(빈 배열/0/null)으로 존재.
 *
 * 스펙 이벤트가 하루에 하나라도 있으면 'total' 행이 나와 그 날 스냅샷이 생성되고, 각
 * metric 의 부분 zero 는 emptySnapshot 초기값으로 표현된다. 반면 스펙 이벤트가 아예 0건인
 * 날은 base 가 비어 그 날짜 자체가 결과에서 빠진다(빈 스냅샷 upsert 안 함) — 의도된 동작이다.
 * 대시보드는 최신 "데이터 있는" 날을 보여주는 편이 전(全)0 스냅샷보다 유용하고, 활동 없는
 * 날까지 매일 빈 row 를 쌓지 않아 저장도 깔끔하다. (구간 내 활동일만 upsert)
 */
export function mapContentRows(rows: ContentSqlRow[], spec: AppContentSpec): ContentMetricByDate {
  const out: ContentMetricByDate = {};
  const ensure = (date: string): ContentMetricSnapshot => (out[date] ??= emptySnapshot(spec));

  for (const r of rows) {
    const snap = ensure(r.date);
    if (r.kind === "dist") {
      (snap.distributions[r.metric] ??= []).push({
        k: r.val,
        count: Math.round(r.a),
        users: Math.round(r.b),
      });
    } else if (r.kind === "cnt") {
      snap.counters[r.metric] = { count: Math.round(r.a), users: Math.round(r.b) };
    } else if (r.kind === "measure") {
      snap.measures[r.metric] = r.a;
    } else if (r.kind === "total") {
      snap.totalEvents = Math.round(r.a);
    }
  }

  for (const snap of Object.values(out)) {
    for (const key of Object.keys(snap.distributions)) {
      snap.distributions[key] = snap.distributions[key]
        // 동률은 key 코드포인트 순(localeCompare 는 ICU/로케일에 따라 흔들려 테스트 비결정적).
        .sort((x, y) => y.count - x.count || (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))
        .slice(0, topNFor(spec, key));
    }
  }
  return out;
}
