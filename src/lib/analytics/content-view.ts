import type {
  AppContentSpec,
  ContentDerivedSpec,
  ContentGroupSpec,
  ContentMetricSpec,
} from "@/lib/analytics/content-spec";
import { DEFAULT_GROUP_TOP_N } from "@/lib/analytics/content-sql";
import type { ContentMetricSnapshot, ContentMetricValue } from "@/lib/analytics/content-source";

// 컨텐츠 지표 스냅샷 + 스펙 → 표시용 뷰 모델(순수). 라벨/퍼센트/단위 포맷을 여기서
// 잠그고, 컴포넌트(AppContentPanels)는 렌더만 한다. 서버/테스트가 공유한다.

/** 단일 지표 카드(flat metric 또는 파생). */
export interface ContentMetricCardView {
  key: string;
  label: string;
  value: string; // 단위 포함 포맷, 데이터 없으면 "—"
  users: number | null; // count 종류만, 그 외 null
}

export interface ContentDistViewItem {
  k: string; // 표시 라벨(valueLabels 적용 후)
  count: number;
  users: number;
  pct: number; // 분포 내 비중(정수 %)
}

export interface ContentDistView {
  key: string;
  label: string;
  total: number;
  items: ContentDistViewItem[];
}

export interface ContentGroupColView {
  key: string;
  label: string;
}

export interface ContentGroupRowView {
  key: string; // 그룹 값 원본 key(정렬/식별용)
  label: string; // valueLabels 적용 후 표시 라벨
  cells: Record<string, string>; // 컬럼 key → 포맷된 값
  reachPct: number; // funnel 표시용: 첫 지표 기준 도달률(%)
}

export interface ContentGroupView {
  key: string;
  label: string;
  render: "table" | "funnel";
  columns: ContentGroupColView[];
  rows: ContentGroupRowView[];
}

export interface ContentView {
  metrics: ContentMetricCardView[];
  distributions: ContentDistView[];
  groups: ContentGroupView[];
  totalEvents: number;
}

function fmt(value: number | null, unit?: string): string {
  if (value == null) return "—";
  return unit ? `${value}${unit}` : String(value);
}

function isCount(agg: ContentMetricSpec["agg"]): boolean {
  return agg === "count";
}

/** 파생 비율 계산(num/den*scale). den=0 또는 값 없음 → null. */
function derivedValue(
  d: ContentDerivedSpec,
  lookup: (key: string) => ContentMetricValue | undefined,
): number | null {
  const num = lookup(d.num)?.value;
  const den = lookup(d.den)?.value;
  if (num == null || den == null || den === 0) return null;
  const round = Number.isFinite(d.round) ? Number(d.round) : 1;
  return Math.round((num / den) * (d.scale ?? 100) * 10 ** round) / 10 ** round;
}

function metricCard(m: ContentMetricSpec, v: ContentMetricValue | undefined): ContentMetricCardView {
  return {
    key: m.key,
    label: m.label,
    value: fmt(v?.value ?? null, m.unit),
    users: isCount(m.agg) ? v?.users ?? 0 : null,
  };
}

function derivedCard(d: ContentDerivedSpec, value: number | null): ContentMetricCardView {
  return { key: d.key, label: d.label, value: fmt(value, d.unit ?? "%"), users: null };
}

/** 그룹 값 정렬(order 고정 우선, 없으면 orderBy 지표 내림차순 → topN). */
function orderedGroupValues(g: ContentGroupSpec, rows: Record<string, Record<string, ContentMetricValue>>): string[] {
  const present = Object.keys(rows);
  if (g.order && g.order.length > 0) return g.order.filter((k) => present.includes(k));
  const sortKey = g.orderBy ?? g.metrics[0]?.key;
  const topN = g.topN && g.topN > 0 ? g.topN : DEFAULT_GROUP_TOP_N;
  return present
    .sort((x, y) => {
      const vx = rows[x]?.[sortKey]?.value ?? 0;
      const vy = rows[y]?.[sortKey]?.value ?? 0;
      return (vy ?? 0) - (vx ?? 0) || (x < y ? -1 : x > y ? 1 : 0);
    })
    .slice(0, topN);
}

function buildGroupView(g: ContentGroupSpec, rowsData: Record<string, Record<string, ContentMetricValue>>): ContentGroupView {
  const columns: ContentGroupColView[] = [
    ...g.metrics.map((m) => ({ key: m.key, label: m.label })),
    ...(g.derived ?? []).map((d) => ({ key: d.key, label: d.label })),
  ];
  const values = orderedGroupValues(g, rowsData);
  const firstKey = g.metrics[0]?.key;
  const maxFirst = Math.max(1, ...values.map((v) => rowsData[v]?.[firstKey]?.value ?? 0));

  const rows: ContentGroupRowView[] = values.map((val) => {
    const data = rowsData[val] ?? {};
    const cells: Record<string, string> = {};
    for (const m of g.metrics) cells[m.key] = fmt(data[m.key]?.value ?? null, m.unit);
    for (const d of g.derived ?? []) {
      cells[d.key] = fmt(derivedValue(d, (k) => data[k]), d.unit ?? "%");
    }
    const first = data[firstKey]?.value ?? 0;
    return {
      key: val,
      label: g.valueLabels?.[val] ?? val,
      cells,
      reachPct: maxFirst > 0 ? Math.round(((first ?? 0) / maxFirst) * 100) : 0,
    };
  });

  return { key: g.key, label: g.label, render: g.render ?? "table", columns, rows };
}

/** 스펙 순서대로 라벨을 붙여 표시용 뷰를 만든다. 스냅샷에 없는 key 는 안전 기본값. */
export function buildContentView(spec: AppContentSpec, snapshot: ContentMetricSnapshot): ContentView {
  const metrics: ContentMetricCardView[] = [
    ...(spec.metrics ?? []).map((m) => metricCard(m, snapshot.metrics[m.key])),
    ...(spec.derived ?? []).map((d) => derivedCard(d, derivedValue(d, (k) => snapshot.metrics[k]))),
  ];

  const distributions: ContentDistView[] = (spec.distributions ?? []).map((d) => {
    const raw = snapshot.distributions[d.key] ?? [];
    const total = raw.reduce((n, i) => n + i.count, 0);
    const items: ContentDistViewItem[] = raw.map((i) => ({
      k: d.valueLabels?.[i.k] ?? i.k,
      count: i.count,
      users: i.users,
      pct: total > 0 ? Math.round((i.count / total) * 100) : 0,
    }));
    return { key: d.key, label: d.label, total, items };
  });

  const groups: ContentGroupView[] = (spec.groups ?? []).map((g) =>
    buildGroupView(g, snapshot.groups[g.key] ?? {}),
  );

  return { metrics, distributions, groups, totalEvents: snapshot.totalEvents };
}
