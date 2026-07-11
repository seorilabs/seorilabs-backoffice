import { runGa4Query } from "@/lib/ga4/bigquery";
import { buildContentSql, mapContentRows, type ContentSqlRow } from "@/lib/ga4/content-shapes";
import type { AppContentSpec } from "@/lib/analytics/content-spec";
import type {
  ContentMetricByDate,
  ContentMetricsSource,
  ContentSourceTarget,
} from "@/lib/analytics/content-source";

// ContentMetricsSource 의 GA4/BigQuery 구현. 스펙을 SQL 로 조립(순수 content-shapes)해
// events export 를 한 번 스캔하고, 응답을 날짜별 스냅샷으로 피벗한다. 향후 자체 지표
// 서버가 서면 같은 ContentMetricsSource 인터페이스의 HTTP 구현으로 교체한다.

// BigQuery 는 정수 컬럼을 { value: "123" } 형태로 줄 수 있어 안전 변환한다.
function num(v: unknown): number {
  const n = typeof v === "object" && v !== null ? Number((v as { value: unknown }).value) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export const ga4ContentSource: ContentMetricsSource = {
  async queryContentMetrics(
    target: ContentSourceTarget,
    spec: AppContentSpec,
    start: string,
    end: string,
  ): Promise<ContentMetricByDate> {
    if (!target.firebaseProject || !target.dataset) {
      throw new Error(`GA4 대상 미해석(${target.slug}) — firebaseProject/dataset 필요`);
    }
    const fromExpr = `\`${target.firebaseProject}.${target.dataset}.events_*\``;
    const sql = buildContentSql(spec, fromExpr, start, end);
    const raw = await runGa4Query<Record<string, unknown>>(target.firebaseProject, target.dataset, sql);
    const rows: ContentSqlRow[] = raw.map((r) => ({
      date: String(r.date),
      kind: String(r.kind),
      metric: String(r.metric),
      val: String(r.val ?? ""),
      a: num(r.a),
      b: num(r.b),
    }));
    return mapContentRows(rows, spec);
  },
};
