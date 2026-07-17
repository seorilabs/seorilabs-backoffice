import { isoDate } from "@/lib/ga4/datasets";

// AppsInToss 콘솔 일별 스냅샷 프레젠테이션 컴포넌트(순수, 서버 렌더). GA4 패널(MetricPanels)과
// 구분되게 sky 계열. 토스 표면 지표 — DAU/신규/세션/광고(IAA)/결제(IAP)/유입경로/데모.

interface DimRate {
  dimension?: string;
  ageGroup?: string;
  gender?: string;
  os?: string;
  value: number;
  rate: number;
}

interface ConsoleRaw {
  referrer?: DimRate[];
  demographics?: { age?: DimRate[]; gender?: DimRate[]; os?: DimRate[] };
  iaaByOs?: Record<string, { impression: number; ecpm: number; earning: number }>;
}

export interface ConsoleMetricDaily {
  date: Date;
  dau: number;
  newUsers: number;
  avgSessionSec: number | null;
  iaaImpressions: number;
  iaaEarningKrw: number;
  iapTrxAmountKrw: number;
  iapSettlementKrw: number;
  payingUsers: number;
  raw: unknown;
}

const won = (v: number): string => `₩${Math.round(v).toLocaleString("ko-KR")}`;
const sec = (v: number | null): string => (v == null ? "—" : `${Math.round(v)}초`);

export function ConsoleMetricCards({ latest }: { latest: ConsoleMetricDaily }) {
  const cards = [
    { label: "DAU", value: String(latest.dau) },
    { label: "신규", value: String(latest.newUsers) },
    { label: "평균 세션", value: sec(latest.avgSessionSec) },
    { label: "광고 노출", value: String(latest.iaaImpressions) },
    { label: "광고 수익", value: won(latest.iaaEarningKrw) },
    { label: "결제자", value: String(latest.payingUsers) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => (
        <div key={c.label} className="rounded-lg border border-neutral-200 bg-white p-3">
          <div className="text-xs text-neutral-500">{c.label}</div>
          <div className="mt-1 text-xl font-semibold text-neutral-900">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

/** DAU 추이 막대(오래된→최신) — 콘솔은 sky. */
export function ConsoleDauTrend({ rowsAsc }: { rowsAsc: ConsoleMetricDaily[] }) {
  const max = Math.max(1, ...rowsAsc.map((r) => r.dau));
  return (
    <div>
      <div className="flex h-24 items-end gap-0.5">
        {rowsAsc.map((r, i) => (
          <div
            key={i}
            className="flex-1 rounded-t bg-sky-400/80 hover:bg-sky-500"
            style={{ height: `${Math.max(2, (r.dau / max) * 100)}%` }}
            title={`${isoDate(r.date)} · DAU ${r.dau} · 신규 ${r.newUsers} · 광고 ${won(r.iaaEarningKrw)}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
        <span>{rowsAsc.length > 0 ? isoDate(rowsAsc[0].date) : ""}</span>
        <span>최대 DAU {max}</span>
        <span>{rowsAsc.length > 0 ? isoDate(rowsAsc[rowsAsc.length - 1].date) : ""}</span>
      </div>
    </div>
  );
}

/** 유입경로/연령/성별 등 비율 목록(비중 막대). */
export function DimRateList({ items, empty }: { items: DimRate[] | undefined; empty?: string }) {
  if (!items || items.length === 0) {
    return <div className="text-sm text-neutral-400">{empty ?? "데이터 없음"}</div>;
  }
  const sorted = [...items].sort((a, b) => b.value - a.value).slice(0, 6);
  const max = Math.max(1, ...sorted.map((i) => i.value));
  return (
    <div className="space-y-1.5">
      {sorted.map((i, idx) => {
        const label = i.dimension ?? i.ageGroup ?? i.gender ?? i.os ?? "—";
        return (
          <div key={idx} className="flex items-center gap-2 text-sm">
            <span className="w-24 shrink-0 truncate text-neutral-700" title={label}>
              {label}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-100">
              <div className="h-full rounded-full bg-sky-400" style={{ width: `${(i.value / max) * 100}%` }} />
            </div>
            <span className="w-14 shrink-0 text-right tabular-nums text-neutral-600">
              {i.value}
              <span className="ml-1 text-neutral-400">{Math.round(i.rate * 100)}%</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 최근 콘솔 지표 추이 표(최신→과거). */
export function ConsoleTrendTable({ rowsDesc }: { rowsDesc: ConsoleMetricDaily[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full min-w-[600px] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">날짜</th>
            <th className="px-3 py-2 text-right">DAU</th>
            <th className="px-3 py-2 text-right">신규</th>
            <th className="px-3 py-2 text-right">세션</th>
            <th className="px-3 py-2 text-right">광고노출</th>
            <th className="px-3 py-2 text-right">광고수익</th>
            <th className="px-3 py-2 text-right">결제자</th>
          </tr>
        </thead>
        <tbody>
          {rowsDesc.map((r) => (
            <tr key={isoDate(r.date)} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
              <td className="px-3 py-1.5 text-neutral-700">{isoDate(r.date)}</td>
              <td className="px-3 py-1.5 text-right">{r.dau}</td>
              <td className="px-3 py-1.5 text-right">{r.newUsers}</td>
              <td className="px-3 py-1.5 text-right text-neutral-600">{sec(r.avgSessionSec)}</td>
              <td className="px-3 py-1.5 text-right text-neutral-600">{r.iaaImpressions}</td>
              <td className="px-3 py-1.5 text-right text-neutral-600">{won(r.iaaEarningKrw)}</td>
              <td className="px-3 py-1.5 text-right text-neutral-600">{r.payingUsers}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 선택 앱의 콘솔 지표 섹션(카드+추이+유입경로+데모). rows 는 최신→과거. */
export function ConsoleSection({ rowsDesc }: { rowsDesc: ConsoleMetricDaily[] }) {
  if (rowsDesc.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
        수집된 콘솔 지표가 아직 없습니다. 콘솔 지표는 온디맨드 수집(대화형)으로 채워집니다.
      </div>
    );
  }
  const latest = rowsDesc[0];
  const rowsAsc = [...rowsDesc].reverse();
  const raw = (latest.raw ?? {}) as ConsoleRaw;
  const demo = raw.demographics ?? {};
  return (
    <div className="space-y-5">
      <ConsoleMetricCards latest={latest} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="유입경로 (전체탭/미니앱홈/검색)">
          <DimRateList items={raw.referrer} empty="유입경로 데이터 없음" />
        </Panel>
        <Panel title="연령대">
          <DimRateList items={demo.age} empty="연령 데이터 없음" />
        </Panel>
        <Panel title="성별">
          <DimRateList items={demo.gender} empty="성별 데이터 없음" />
        </Panel>
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">DAU 추이 (최근 {rowsAsc.length}일)</div>
        <ConsoleDauTrend rowsAsc={rowsAsc} />
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">일별 상세</div>
        <ConsoleTrendTable rowsDesc={rowsDesc} />
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-neutral-700">{title}</div>
      {children}
    </div>
  );
}
