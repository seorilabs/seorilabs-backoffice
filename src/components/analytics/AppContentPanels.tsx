import Link from "next/link";
import type { AppContentSpec } from "@/lib/analytics/content-spec";
import type { ContentMetricSnapshot } from "@/lib/analytics/content-source";
import {
  buildContentView,
  type ContentDistView,
  type ContentGroupView,
} from "@/lib/analytics/content-view";
import { marketTabs } from "@/lib/analytics/market";

// 앱 컨텐츠 세부 지표 프레젠테이션(순수 서버 컴포넌트, tailwind). 모든 게임이 이 한 렌더러를
// 공유한다(happy-farm/foam/crossword 의 bespoke 컴포넌트를 대체). 스펙+스냅샷 →
// buildContentView(순수)로 표시 모델을 만든 뒤 렌더만 한다. 표현 요소:
//   - metrics(+파생): 스탯 카드   - distributions: 막대 분포
//   - groups: 표(table) 또는 도달률 퍼널(funnel)   - market: 상단 탭(스펙 선언 시)

const DIST_BAR = "bg-indigo-400";
const FUNNEL_BAR = "bg-emerald-400";

/** 마켓 탭(스펙이 마켓을 선언한 경우만). 선택 마켓은 강조. */
export function ContentMarketTabs({
  spec,
  appSlug,
  selected,
}: {
  spec: AppContentSpec;
  appSlug: string;
  selected: string;
}) {
  const tabs = marketTabs(spec);
  if (tabs.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={`/analytics?app=${appSlug}&market=${t.key}`}
          className={`rounded px-2.5 py-1 text-xs font-medium transition ${
            t.key === selected
              ? "bg-neutral-800 text-white"
              : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

export function ContentSection({
  spec,
  snapshot,
}: {
  spec: AppContentSpec;
  snapshot: ContentMetricSnapshot;
}) {
  const view = buildContentView(spec, snapshot);
  return (
    <div className="space-y-6">
      {view.metrics.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-semibold text-neutral-700">컨텐츠 지표</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {view.metrics.map((m) => (
              <div key={m.key} className="rounded-lg border border-neutral-200 bg-white p-3">
                <div className="text-xs text-neutral-500">{m.label}</div>
                <div className="mt-1 text-2xl font-semibold text-neutral-900">{m.value}</div>
                {m.users != null && <div className="text-[11px] text-neutral-400">{m.users}명</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {view.groups.map((g) => (
        <div key={g.key}>
          <div className="mb-2 text-sm font-semibold text-neutral-700">{g.label}</div>
          {g.render === "funnel" ? <GroupFunnel g={g} /> : <GroupTable g={g} />}
        </div>
      ))}

      {view.distributions.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {view.distributions.map((d) => (
            <div key={d.key} className="rounded-lg border border-neutral-200 bg-white p-4">
              <div className="mb-3 flex items-baseline justify-between">
                <span className="text-sm font-semibold text-neutral-700">{d.label}</span>
                <span className="text-[11px] text-neutral-400">합계 {d.total}</span>
              </div>
              <DistList d={d} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DistList({ d }: { d: ContentDistView }) {
  if (d.items.length === 0) {
    return <div className="text-sm text-neutral-400">데이터 없음</div>;
  }
  const max = Math.max(1, ...d.items.map((i) => i.count));
  return (
    <div className="space-y-1.5">
      {d.items.map((i) => (
        <div key={i.k} className="flex items-center gap-2 text-sm">
          <span className="w-24 shrink-0 truncate text-neutral-700" title={i.k}>
            {i.k}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-100">
            <div className={`h-full rounded-full ${DIST_BAR}`} style={{ width: `${(i.count / max) * 100}%` }} />
          </div>
          <span className="w-16 shrink-0 text-right tabular-nums text-neutral-600">
            {i.count}
            <span className="ml-1 text-[11px] text-neutral-400">{i.pct}%</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function GroupTable({ g }: { g: ContentGroupView }) {
  if (g.rows.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-400">
        데이터 없음
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">{g.label}</th>
            {g.columns.map((c) => (
              <th key={c.key} className="px-3 py-2 text-right">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {g.rows.map((r) => (
            <tr key={r.key} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
              <td className="px-3 py-2 font-medium text-neutral-700" title={r.key}>
                {r.label}
              </td>
              {g.columns.map((c) => (
                <td key={c.key} className="px-3 py-2 text-right tabular-nums text-neutral-600">
                  {r.cells[c.key] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupFunnel({ g }: { g: ContentGroupView }) {
  if (g.rows.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-400">
        데이터 없음
      </div>
    );
  }
  // 부가 지표(첫 지표 제외)를 우측에 요약 표시.
  const extraCols = g.columns.slice(1);
  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4">
      {g.rows.map((r) => (
        <div key={r.key} className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 truncate text-neutral-700" title={r.key}>
            {r.label}
          </span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
            <div className={`h-full rounded-full ${FUNNEL_BAR}`} style={{ width: `${r.reachPct}%` }} />
          </div>
          <span className="w-12 shrink-0 text-right tabular-nums text-neutral-500">{r.reachPct}%</span>
          <span className="w-16 shrink-0 text-right tabular-nums text-neutral-700">
            {r.cells[g.columns[0].key]}
          </span>
          {extraCols.length > 0 && (
            <span className="hidden shrink-0 gap-2 text-[11px] text-neutral-400 sm:flex">
              {extraCols.map((c) => (
                <span key={c.key}>
                  {c.label} {r.cells[c.key]}
                </span>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
