import type { AppContentSpec } from "@/lib/analytics/content-spec";
import type { ContentMetricSnapshot } from "@/lib/analytics/content-source";
import { buildContentView, type ContentDistView } from "@/lib/analytics/content-view";

// 앱 컨텐츠 세부 지표 프레젠테이션(순수 서버 컴포넌트, tailwind). 공통 지표 패널과
// 동일한 톤. 스펙+스냅샷 → buildContentView(순수)로 표시 모델을 만든 뒤 렌더만 한다.

const DIST_BAR = "bg-indigo-400";

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
      {view.counters.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-semibold text-neutral-700">컨텐츠 활동</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {view.counters.map((c) => (
              <div key={c.key} className="rounded-lg border border-neutral-200 bg-white p-3">
                <div className="text-xs text-neutral-500">{c.label}</div>
                <div className="mt-1 text-2xl font-semibold text-neutral-900">{c.count}</div>
                <div className="text-[11px] text-neutral-400">{c.users}명</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {view.measures.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-semibold text-neutral-700">대국 지표</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {view.measures.map((m) => (
              <div key={m.key} className="rounded-lg border border-neutral-200 bg-white p-3">
                <div className="text-xs text-neutral-500">{m.label}</div>
                <div className="mt-1 text-2xl font-semibold text-neutral-900">{m.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

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
