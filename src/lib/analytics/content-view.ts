import type { AppContentSpec } from "@/lib/analytics/content-spec";
import type { ContentMetricSnapshot } from "@/lib/analytics/content-source";

// 컨텐츠 지표 스냅샷 + 스펙 → 표시용 뷰 모델(순수). 라벨/퍼센트/단위 포맷을 여기서
// 잠그고, 컴포넌트(ContentPanels)는 렌더만 한다. 서버/테스트가 공유한다.

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

export interface ContentCounterView {
  key: string;
  label: string;
  count: number;
  users: number;
}

export interface ContentMeasureView {
  key: string;
  label: string;
  value: string; // 단위 포함 포맷("37.5수"), 데이터 없으면 "—"
}

export interface ContentView {
  distributions: ContentDistView[];
  counters: ContentCounterView[];
  measures: ContentMeasureView[];
  totalEvents: number;
}

function fmtMeasure(value: number | null, unit?: string): string {
  if (value == null) return "—";
  return unit ? `${value}${unit}` : String(value);
}

/** 스펙 순서대로 라벨을 붙여 표시용 뷰를 만든다. 스냅샷에 없는 key 는 안전 기본값. */
export function buildContentView(spec: AppContentSpec, snapshot: ContentMetricSnapshot): ContentView {
  const distributions: ContentDistView[] = spec.distributions.map((d) => {
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

  const counters: ContentCounterView[] = spec.counters.map((c) => {
    const v = snapshot.counters[c.key] ?? { count: 0, users: 0 };
    return { key: c.key, label: c.label, count: v.count, users: v.users };
  });

  const measures: ContentMeasureView[] = spec.measures.map((m) => ({
    key: m.key,
    label: m.label,
    value: fmtMeasure(snapshot.measures[m.key] ?? null, m.unit),
  }));

  return { distributions, counters, measures, totalEvents: snapshot.totalEvents };
}
