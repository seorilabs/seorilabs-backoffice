import Link from "next/link";
import {
  MARKETS,
  MARKET_LABEL,
  type Market,
  type LevelTotal,
  type MonetizationTotal,
  type MissionTotal,
  type EconomyTotal,
  type MonetizationKind,
} from "@/lib/analytics/foam-content-shapes";

// 콘텐츠 세부 지표 프레젠테이션(순수, 서버 컴포넌트). 이미 시장 필터 + 롤업된 데이터를
// 받는다. 차트 라이브러리 없이 tailwind 로 비중 막대만 그린다(공통 MetricPanels 와 동일 톤).

const pct = (v: number | null): string => (v == null ? "—" : `${v}%`);
const numOr = (v: number | null, suffix = ""): string => (v == null ? "—" : `${v}${suffix}`);

// ── 시장 탭(통합/Play/App Store/AIT) ────────────────────────────────────────
export function MarketTabs({
  appSlug,
  selected,
}: {
  appSlug: string;
  selected: Market | "all";
}) {
  const base = `/analytics?app=${appSlug}`;
  const tabs: { key: Market | "all"; label: string }[] = [
    { key: "all", label: "통합" },
    ...MARKETS.map((m) => ({ key: m, label: MARKET_LABEL[m] })),
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.key === "all" ? base : `${base}&market=${t.key}`}
          className={`rounded px-2.5 py-1 text-xs font-medium transition ${
            selected === t.key
              ? "bg-neutral-900 text-white"
              : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

function BarCell({ value, max, cls }: { value: number; max: number; cls: string }) {
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-100">
      <div className={`h-full rounded-full ${cls}`} style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }} />
    </div>
  );
}

// ── 레벨 퍼널 ───────────────────────────────────────────────────────────────
export function LevelFunnel({ rows }: { rows: LevelTotal[] }) {
  if (rows.length === 0) {
    return <Empty>레벨 데이터 없음</Empty>;
  }
  const maxStarts = Math.max(1, ...rows.map((r) => r.starts));
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">레벨</th>
            <th className="px-3 py-2 text-right">시작</th>
            <th className="px-3 py-2 text-right">완료</th>
            <th className="px-3 py-2">완료율</th>
            <th className="px-3 py-2 text-right">플레이어</th>
            <th className="px-3 py-2 text-right">평균 클리어</th>
            <th className="px-3 py-2 text-right">평균 별</th>
            <th className="px-3 py-2 text-right">획득 코인</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.level} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
              <td className="px-3 py-1.5 font-medium text-neutral-700">Lv {r.level}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.starts}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.completes}</td>
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <BarCell value={r.completes} max={r.starts} cls="bg-emerald-400" />
                  <span className="w-12 shrink-0 text-right text-xs tabular-nums text-neutral-600">
                    {pct(r.completionRate)}
                  </span>
                </div>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600">{r.players}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600">{numOr(r.avgClearSec, "s")}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600">{numOr(r.avgStars, "★")}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600">{r.coinsEarned}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-neutral-100 px-3 py-1.5 text-[11px] text-neutral-400">
        완료율 막대 = 완료/시작. 시작 대비 이탈이 큰 레벨이 난이도/이탈 지점.
        <span className="ml-1 text-neutral-300">(최대 시작 {maxStarts})</span>
      </div>
    </div>
  );
}

// ── 수익화 분포 ─────────────────────────────────────────────────────────────
const KIND_LABEL: Record<MonetizationKind, string> = {
  skin: "스킨 구매",
  upgrade: "업그레이드",
  foam_bomb: "폼밤 사용",
};
const KIND_CLS: Record<MonetizationKind, string> = {
  skin: "bg-violet-400",
  upgrade: "bg-sky-400",
  foam_bomb: "bg-amber-400",
};

export function MonetizationPanel({ rows }: { rows: MonetizationTotal[] }) {
  if (rows.length === 0) {
    return <Empty>수익화 이벤트 없음</Empty>;
  }
  const kinds: MonetizationKind[] = ["skin", "upgrade", "foam_bomb"];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {kinds.map((kind) => {
        const items = rows.filter((r) => r.kind === kind);
        const max = Math.max(1, ...items.map((i) => i.count));
        const totalCoins = items.reduce((n, i) => n + i.coinsSpent, 0);
        const totalAd = items.reduce((n, i) => n + i.adCount, 0);
        return (
          <div key={kind} className="rounded-lg border border-neutral-200 bg-white p-4">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-sm font-semibold text-neutral-700">{KIND_LABEL[kind]}</span>
              <span className="text-xs text-neutral-400">
                {kind === "foam_bomb" ? `광고 ${totalAd}` : `코인 ${totalCoins}`}
              </span>
            </div>
            {items.length === 0 ? (
              <div className="py-3 text-sm text-neutral-400">데이터 없음</div>
            ) : (
              <div className="space-y-1.5">
                {items.map((i) => (
                  <div key={i.itemKey} className="flex items-center gap-2 text-sm">
                    <span className="w-20 shrink-0 truncate text-neutral-700" title={i.itemKey}>
                      {i.itemKey}
                    </span>
                    <BarCell value={i.count} max={max} cls={KIND_CLS[kind]} />
                    <span className="w-10 shrink-0 text-right tabular-nums text-neutral-600">{i.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── 미션·리텐션 훅 ───────────────────────────────────────────────────────────
export function MissionPanel({ rows }: { rows: MissionTotal[] }) {
  if (rows.length === 0) {
    return <Empty>미션 클레임 없음</Empty>;
  }
  const max = Math.max(1, ...rows.map((r) => r.claims));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.missionType} className="flex items-center gap-2 text-sm">
          <span className="w-24 shrink-0 truncate text-neutral-700" title={r.missionType}>
            {r.missionType}
          </span>
          <BarCell value={r.claims} max={max} cls="bg-rose-400" />
          <span className="w-12 shrink-0 text-right tabular-nums text-neutral-600">{r.claims}</span>
          <span className="w-16 shrink-0 text-right text-xs tabular-nums text-neutral-400">
            {r.users}명
          </span>
        </div>
      ))}
    </div>
  );
}

// ── 경제/재화 흐름 ───────────────────────────────────────────────────────────
export function EconomyPanel({ econ }: { econ: EconomyTotal }) {
  const rows: { label: string; value: number; cls: string; side: "src" | "sink" }[] = [
    { label: "레벨 완료", value: econ.coinsFromLevels, cls: "bg-emerald-400", side: "src" },
    { label: "미션 보상", value: econ.coinsFromMissions, cls: "bg-teal-400", side: "src" },
    { label: "업그레이드", value: econ.coinsToUpgrades, cls: "bg-sky-400", side: "sink" },
    { label: "스킨", value: econ.coinsToSkins, cls: "bg-violet-400", side: "sink" },
    { label: "폼밤(코인)", value: econ.coinsToFoamBombs, cls: "bg-amber-400", side: "sink" },
  ];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="총 획득" value={econ.sources} tone="text-emerald-600" />
        <Stat label="총 소비" value={econ.sinks} tone="text-rose-600" />
        <Stat
          label="순증"
          value={econ.net}
          tone={econ.net >= 0 ? "text-emerald-600" : "text-rose-600"}
        />
      </div>
      <div className="mt-4 space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2 text-sm">
            <span className="w-24 shrink-0 text-neutral-600">
              {r.side === "src" ? "▲" : "▼"} {r.label}
            </span>
            <BarCell value={r.value} max={max} cls={r.cls} />
            <span className="w-16 shrink-0 text-right tabular-nums text-neutral-600">{r.value}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[11px] text-neutral-400">
        폼밤 사용 · 광고 {econ.foamBombAd} / 코인 {econ.foamBombCoin}. ▲=획득(소스) ▼=소비(싱크).
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3 text-center">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-neutral-400">{children}</div>;
}
