import {
  plantToHarvestRate,
  avgRevenuePerHarvest,
  unlockConversionRate,
} from "@/lib/ga4/content-shapes";

// happy-farm 콘텐츠 세부 지표 프레젠테이션(순수 서버 컴포넌트, tailwind, 차트 라이브러리 없음).
// 공통 지표 패널(MetricPanels)과 동일한 톤/구현 방식을 따른다.

export interface CropRow {
  crop: string;
  planted: number;
  ready: number;
  harvested: number;
  seedSelected: number;
  firstHarvests: number;
  cotdHarvests: number;
  harvesters: number;
  revenue: number;
}

export interface AreaRow {
  area: string;
  unlockClicked: number;
  unlocked: number;
  planted: number;
  harvested: number;
  unlockCostSum: number;
}

export interface FunnelRow {
  funnel: string;
  step: string;
  count: number;
  users: number;
  skips: number;
  stalls: number;
}

export interface AdPlacementRow {
  placement: string;
  impressions: number;
  clicks: number;
  completes: number;
  fails: number;
  failsNotReady: number;
  blocked: number;
}

const nf = (n: number): string => n.toLocaleString("en-US");
const pctText = (v: number | null): string => (v == null ? "—" : `${v}%`);
const ratio = (a: number, b: number): string =>
  b <= 0 ? "—" : `${Math.round((a / b) * 1000) / 10}%`;

function EmptyRow({ span, text }: { span: number; text: string }) {
  return (
    <tr>
      <td colSpan={span} className="px-3 py-4 text-center text-sm text-neutral-400">
        {text}
      </td>
    </tr>
  );
}

// ── 작물 지표 표(매출 상위) ─────────────────────────────────────────────────
export function CropMetricTable({ rows, limit = 15 }: { rows: CropRow[]; limit?: number }) {
  const shown = rows.slice(0, limit);
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">작물</th>
            <th className="px-3 py-2 text-right">심기</th>
            <th className="px-3 py-2 text-right">수확</th>
            <th className="px-3 py-2 text-right">수확자</th>
            <th className="px-3 py-2 text-right">매출</th>
            <th className="px-3 py-2 text-right">심기→수확</th>
            <th className="px-3 py-2 text-right">수확당매출</th>
            <th className="px-3 py-2 text-right">첫수확</th>
            <th className="px-3 py-2 text-right">오늘의작물</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <EmptyRow span={9} text="작물 지표 없음" />
          ) : (
            shown.map((r) => (
              <tr key={r.crop} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                <td className="px-3 py-1.5 font-medium text-neutral-800">{r.crop}</td>
                <td className="px-3 py-1.5 text-right">{nf(r.planted)}</td>
                <td className="px-3 py-1.5 text-right">{nf(r.harvested)}</td>
                <td className="px-3 py-1.5 text-right text-neutral-600">{nf(r.harvesters)}</td>
                <td className="px-3 py-1.5 text-right font-medium">{nf(r.revenue)}</td>
                <td className="px-3 py-1.5 text-right text-neutral-600">
                  {pctText(plantToHarvestRate(r.harvested, r.planted))}
                </td>
                <td className="px-3 py-1.5 text-right text-neutral-600">
                  {(() => {
                    const v = avgRevenuePerHarvest(r.revenue, r.harvested);
                    return v == null ? "—" : nf(v);
                  })()}
                </td>
                <td className="px-3 py-1.5 text-right text-neutral-500">{nf(r.firstHarvests)}</td>
                <td className="px-3 py-1.5 text-right text-neutral-500">{nf(r.cotdHarvests)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── 구역 언락 퍼널 ──────────────────────────────────────────────────────────
export function AreaFunnelTable({ rows }: { rows: AreaRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">구역</th>
            <th className="px-3 py-2 text-right">언락시도</th>
            <th className="px-3 py-2 text-right">언락완료</th>
            <th className="px-3 py-2 text-right">전환율</th>
            <th className="px-3 py-2 text-right">심기</th>
            <th className="px-3 py-2 text-right">수확</th>
            <th className="px-3 py-2 text-right">언락비용</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow span={7} text="구역 지표 없음" />
          ) : (
            rows.map((r) => (
              <tr key={r.area} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                <td className="px-3 py-1.5 font-medium text-neutral-800">{r.area}</td>
                <td className="px-3 py-1.5 text-right">{nf(r.unlockClicked)}</td>
                <td className="px-3 py-1.5 text-right">{nf(r.unlocked)}</td>
                <td className="px-3 py-1.5 text-right text-neutral-600">
                  {pctText(unlockConversionRate(r.unlocked, r.unlockClicked))}
                </td>
                <td className="px-3 py-1.5 text-right text-neutral-600">{nf(r.planted)}</td>
                <td className="px-3 py-1.5 text-right text-neutral-600">{nf(r.harvested)}</td>
                <td className="px-3 py-1.5 text-right text-neutral-500">{nf(r.unlockCostSum)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── 광고 placement 퍼널 ─────────────────────────────────────────────────────
export function AdPlacementTable({ rows }: { rows: AdPlacementRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">placement</th>
            <th className="px-3 py-2 text-right">노출</th>
            <th className="px-3 py-2 text-right">클릭</th>
            <th className="px-3 py-2 text-right">완료</th>
            <th className="px-3 py-2 text-right">CTR</th>
            <th className="px-3 py-2 text-right">완료율</th>
            <th className="px-3 py-2 text-right">실패</th>
            <th className="px-3 py-2 text-right">차단</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow span={8} text="광고 지표 없음" />
          ) : (
            rows.map((r) => (
              <tr key={r.placement} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                <td className="px-3 py-1.5 font-medium text-neutral-800">{r.placement}</td>
                <td className="px-3 py-1.5 text-right">{nf(r.impressions)}</td>
                <td className="px-3 py-1.5 text-right">{nf(r.clicks)}</td>
                <td className="px-3 py-1.5 text-right">{nf(r.completes)}</td>
                <td className="px-3 py-1.5 text-right text-neutral-600">{ratio(r.clicks, r.impressions)}</td>
                <td className="px-3 py-1.5 text-right text-neutral-600">{ratio(r.completes, r.clicks)}</td>
                <td className="px-3 py-1.5 text-right text-neutral-500">{nf(r.fails)}</td>
                <td className="px-3 py-1.5 text-right text-neutral-500">{nf(r.blocked)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── 기능 퍼널(온보딩 단계 도달률 + 기타 퍼널 카운트) ───────────────────────
const ONBOARDING_STEP_ORDER = ["selectSeed", "plant", "harvest", "unlock", "complete"];
const FUNNEL_LABEL: Record<string, string> = {
  onboarding: "온보딩",
  prestige: "프레스티지",
  research: "연구",
  collection: "컬렉션",
};

function orderOnboarding(rows: FunnelRow[]): FunnelRow[] {
  return [...rows].sort((a, b) => {
    const ia = ONBOARDING_STEP_ORDER.indexOf(a.step);
    const ib = ONBOARDING_STEP_ORDER.indexOf(b.step);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

export function FeatureFunnelPanels({ rows }: { rows: FunnelRow[] }) {
  const byFunnel = new Map<string, FunnelRow[]>();
  for (const r of rows) {
    const list = byFunnel.get(r.funnel) ?? [];
    list.push(r);
    byFunnel.set(r.funnel, list);
  }
  if (byFunnel.size === 0) {
    return <div className="text-sm text-neutral-400">기능 퍼널 지표 없음</div>;
  }

  const onboarding = byFunnel.get("onboarding");
  const others = [...byFunnel.entries()].filter(([f]) => f !== "onboarding");

  return (
    <div className="space-y-4">
      {onboarding && onboarding.length > 0 && (
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="mb-3 text-sm font-semibold text-neutral-700">온보딩 단계 도달률</div>
          <OnboardingFunnel rows={orderOnboarding(onboarding)} />
        </div>
      )}
      {others.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {others.map(([funnel, list]) => (
            <div key={funnel} className="rounded-lg border border-neutral-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-neutral-700">
                {FUNNEL_LABEL[funnel] ?? funnel}
              </div>
              <div className="space-y-1.5">
                {list
                  .slice()
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 8)
                  .map((r) => (
                    <div key={r.step} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-neutral-700" title={r.step}>
                        {r.step}
                      </span>
                      <span className="tabular-nums text-neutral-600">
                        {nf(r.count)}
                        <span className="ml-1 text-neutral-400">({nf(r.users)}명)</span>
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OnboardingFunnel({ rows }: { rows: FunnelRow[] }) {
  // 도달률은 첫 단계 users 대비. 첫 단계 users 가 0 이면 count 로 폴백.
  const first = rows[0];
  const base = first ? (first.users > 0 ? first.users : first.count) : 0;
  const denom = base > 0 ? base : 1;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const value = r.users > 0 ? r.users : r.count;
        const width = Math.max(2, Math.round((value / denom) * 100));
        return (
          <div key={r.step} className="flex items-center gap-2 text-sm">
            <span className="w-24 shrink-0 truncate text-neutral-700" title={r.step}>
              {r.step}
            </span>
            <div className="h-3 flex-1 overflow-hidden rounded-full bg-neutral-100">
              <div className="h-full rounded-full bg-emerald-400/80" style={{ width: `${width}%` }} />
            </div>
            <span className="w-14 shrink-0 text-right tabular-nums text-neutral-600">{nf(value)}</span>
            <span className="w-12 shrink-0 text-right tabular-nums text-neutral-400">
              {base > 0 ? `${Math.round((value / denom) * 100)}%` : "—"}
            </span>
            {r.skips > 0 && (
              <span className="w-16 shrink-0 text-right text-xs text-amber-600" title="이탈(skip)">
                skip {nf(r.skips)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
