import { isoDate } from "@/lib/ga4/datasets";

// GA4 일별 스냅샷의 프레젠테이션 컴포넌트(순수). 대시보드/앱상세에서 공유.
// 서버 컴포넌트에서 렌더 — 클라이언트 상태 없음(차트 라이브러리 미사용, tailwind 로 구현).

export interface MetricDaily {
  date: Date;
  dau: number;
  newUsers: number;
  d1Pct: number | null;
  d3Pct: number | null;
  d7Pct: number | null;
  engagedUsers: number;
  avgEngageSec: number | null;
  adEventUsers: number;
  adImpressions: number;
}

const pct = (v: number | null): string => (v == null ? "—" : `${v}%`);

export function MetricCards({ latest }: { latest: MetricDaily }) {
  const cards: { label: string; value: string | number }[] = [
    { label: "DAU", value: latest.dau },
    { label: "신규", value: latest.newUsers },
    { label: "D1 잔존", value: pct(latest.d1Pct) },
    { label: "D7 잔존", value: pct(latest.d7Pct) },
    { label: "engagement", value: `${latest.engagedUsers}명` },
    { label: "광고 노출", value: latest.adImpressions },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => (
        <div key={c.label} className="rounded-lg border border-neutral-200 bg-white p-3">
          <div className="text-xs text-neutral-500">{c.label}</div>
          <div className="mt-1 text-2xl font-semibold text-neutral-900">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

/** DAU 추이 막대(오래된→최신). 차트 라이브러리 없이 tailwind 높이 %. */
export function DauTrend({ rowsAsc }: { rowsAsc: MetricDaily[] }) {
  const max = Math.max(1, ...rowsAsc.map((r) => r.dau));
  return (
    <div>
      <div className="flex h-28 items-end gap-0.5">
        {rowsAsc.map((r, i) => (
          <div
            key={i}
            className="flex-1 rounded-t bg-emerald-400/80 hover:bg-emerald-500"
            style={{ height: `${Math.max(2, (r.dau / max) * 100)}%` }}
            title={`${isoDate(r.date)} · DAU ${r.dau} · 신규 ${r.newUsers}`}
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

/** 최근 지표 추이 표(최신→과거). */
export function MetricTrendTable({ rowsDesc }: { rowsDesc: MetricDaily[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">날짜</th>
            <th className="px-3 py-2 text-right">DAU</th>
            <th className="px-3 py-2 text-right">신규</th>
            <th className="px-3 py-2 text-right">D1</th>
            <th className="px-3 py-2 text-right">D7</th>
            <th className="px-3 py-2 text-right">engagement</th>
            <th className="px-3 py-2 text-right">광고노출</th>
          </tr>
        </thead>
        <tbody>
          {rowsDesc.map((r) => (
            <tr key={isoDate(r.date)} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
              <td className="px-3 py-1.5 text-neutral-700">{isoDate(r.date)}</td>
              <td className="px-3 py-1.5 text-right">{r.dau}</td>
              <td className="px-3 py-1.5 text-right">{r.newUsers}</td>
              <td className="px-3 py-1.5 text-right text-neutral-600">{pct(r.d1Pct)}</td>
              <td className="px-3 py-1.5 text-right text-neutral-600">{pct(r.d7Pct)}</td>
              <td className="px-3 py-1.5 text-right text-neutral-600">{r.engagedUsers}</td>
              <td className="px-3 py-1.5 text-right text-neutral-600">{r.adImpressions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
