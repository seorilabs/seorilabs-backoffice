import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { resolveGa4Target, isoDate, latestClosedDay, dateWindow, parseIsoDate } from "@/lib/ga4/datasets";
import {
  MetricCards,
  DauTrend,
  MetricTrendTable,
  PlatformSplit,
  TopDimList,
  type MetricDaily,
} from "@/components/analytics/MetricPanels";
import {
  MarketTabs,
  LevelFunnel,
  MonetizationPanel,
  MissionPanel,
  EconomyPanel,
} from "@/components/analytics/ContentPanels";
import {
  MARKETS,
  MARKET_LABEL,
  marketOf,
  filterByMarket,
  rollupLevels,
  rollupMonetization,
  rollupMissions,
  rollupEconomy,
  type Market,
  type LevelMetricRow,
  type MonetizationRow,
  type MonetizationKind,
  type MissionRow,
  type EconomyRow,
} from "@/lib/analytics/content-shapes";

export const dynamic = "force-dynamic";

const WINDOW = 28;
const CONTENT_WINDOW = 28;

const pct = (v: number | null): string => (v == null ? "—" : `${v}%`);

function parseMarket(v: string | undefined): Market | "all" {
  return v && (MARKETS as readonly string[]).includes(v) ? (v as Market) : "all";
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string; market?: string }>;
}) {
  const sp = await searchParams;

  const allApps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: { id: true, slug: true, displayName: true, firebaseProject: true, ga4Dataset: true },
  });
  const apps = allApps.filter((a) => resolveGa4Target(a));
  const selected = apps.find((a) => a.slug === sp.app) ?? null;

  return (
    <div className="px-4 py-6 sm:p-8">
      <h1 className="text-xl font-semibold">앱 지표</h1>
      <p className="mt-1 mb-4 text-sm text-neutral-500">
        GA4 → BigQuery 일별 스냅샷 · 기준일 D-1(전일 확정) · 매일 21:00 KST 수집
      </p>

      {/* 앱 선택 탭 */}
      <div className="mb-5 flex flex-wrap gap-1.5">
        <TabLink href="/analytics" active={!selected} label="전체" />
        {apps.map((a) => (
          <TabLink
            key={a.id}
            href={`/analytics?app=${a.slug}`}
            active={selected?.id === a.id}
            label={a.displayName}
          />
        ))}
      </div>

      {apps.length === 0 ? (
        <Notice>GA4 지표 대상 앱이 없습니다. (App.ga4Dataset 매핑 또는 fallback 표 확인)</Notice>
      ) : selected ? (
        <SelectedApp
          appId={selected.id}
          slug={selected.slug}
          name={selected.displayName}
          market={parseMarket(sp.market)}
        />
      ) : (
        <Overview apps={apps} />
      )}
    </div>
  );
}

async function SelectedApp({
  appId,
  slug,
  name,
  market,
}: {
  appId: string;
  slug: string;
  name: string;
  market: Market | "all";
}) {
  const rowsDesc = (await prisma.appMetricDaily.findMany({
    where: { appId },
    orderBy: { date: "desc" },
    take: WINDOW,
  })) as unknown as MetricDaily[];

  if (rowsDesc.length === 0) {
    return <Notice>{name}의 수집된 지표가 아직 없습니다. 수집 후 표시됩니다.</Notice>;
  }
  const latest = rowsDesc[0];
  const rowsAsc = [...rowsDesc].reverse();
  const bd = latest.raw ?? {};

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">
          핵심 지표 <span className="text-neutral-400">(기준일 {isoDate(latest.date)})</span>
        </div>
        <MetricCards latest={latest} />
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">플랫폼 비중 (DAU)</div>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <PlatformSplit latest={latest} />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="국가 Top (DAU)">
          <TopDimList items={bd.countries} empty="국가 데이터 없음" />
        </Panel>
        <Panel title="기기 유형 (DAU)">
          <TopDimList items={bd.devices} empty="기기 데이터 없음" />
        </Panel>
        <Panel title="OS 버전 (DAU)">
          <TopDimList items={bd.osVersions} empty="OS 데이터 없음" />
        </Panel>
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">DAU 추이 (최근 {rowsAsc.length}일)</div>
        <DauTrend rowsAsc={rowsAsc} />
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">일별 상세</div>
        <MetricTrendTable rowsDesc={rowsDesc} />
      </div>

      {/* 콘텐츠 세부 지표 (레벨/수익화/미션/경제) — 시장 통합·개별 필터 */}
      <ContentSection appId={appId} slug={slug} market={market} />
    </div>
  );
}

// 콘텐츠 세부 지표 섹션. 최근 CONTENT_WINDOW 일 typed 행을 시장 필터+롤업해서 렌더.
async function ContentSection({
  appId,
  slug,
  market,
}: {
  appId: string;
  slug: string;
  market: Market | "all";
}) {
  const cutoff = parseIsoDate(isoDate(dateWindow(latestClosedDay(new Date()), CONTENT_WINDOW)[0]));
  const where = { appId, date: { gte: cutoff } };
  const [levelDb, monDb, misDb, econDb] = await Promise.all([
    prisma.appLevelMetricDaily.findMany({ where }),
    prisma.appMonetizationDaily.findMany({ where }),
    prisma.appMissionMetricDaily.findMany({ where }),
    prisma.appEconomyMetricDaily.findMany({ where }),
  ]);

  const total = levelDb.length + monDb.length + misDb.length + econDb.length;
  if (total === 0) {
    return (
      <div>
        <div className="mb-2 mt-2 text-sm font-semibold text-neutral-700">콘텐츠 세부 지표</div>
        <Notice>
          {slug}의 콘텐츠 이벤트 지표가 아직 없습니다. (레벨/수익화/미션/경제 이벤트 수집 후 표시)
        </Notice>
      </div>
    );
  }

  const levels = rollupLevels(filterByMarket(levelDb.map(toLevelRow).filter(isRow), market));
  const monetization = rollupMonetization(
    filterByMarket(monDb.map(toMonetizationRow).filter(isRow), market),
  );
  const missions = rollupMissions(filterByMarket(misDb.map(toMissionRow).filter(isRow), market));
  const economy = rollupEconomy(filterByMarket(econDb.map(toEconomyRow).filter(isRow), market));

  const marketLabel = market === "all" ? "통합(전 마켓)" : MARKET_LABEL[market];

  return (
    <div className="space-y-6 border-t border-neutral-200 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-neutral-700">
          콘텐츠 세부 지표 <span className="text-neutral-400">· {marketLabel} · 최근 {CONTENT_WINDOW}일 합계</span>
        </div>
        <MarketTabs appSlug={slug} selected={market} />
      </div>

      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">레벨 퍼널</div>
        <LevelFunnel rows={levels} />
      </div>

      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">수익화 분포</div>
        <MonetizationPanel rows={monetization} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="미션·리텐션 훅 (클레임)">
          <MissionPanel rows={missions} />
        </Panel>
        <Panel title="경제/재화 흐름 (코인)">
          <EconomyPanel econ={economy} />
        </Panel>
      </div>
    </div>
  );
}

// ── Prisma 행 → 캐노니컬 콘텐츠 행 매핑(미지원 platform 은 null → 제외) ──────────
const isRow = <T,>(r: T | null): r is T => r !== null;

type LevelDb = {
  date: Date;
  platform: string;
  level: number;
  starts: number;
  completes: number;
  players: number;
  avgClearSec: number | null;
  avgStars: number | null;
  coinsEarned: number;
};
function toLevelRow(r: LevelDb): LevelMetricRow | null {
  const m = marketOf(r.platform);
  if (!m) return null;
  return {
    date: isoDate(r.date),
    market: m,
    level: r.level,
    starts: r.starts,
    completes: r.completes,
    players: r.players,
    avgClearSec: r.avgClearSec,
    avgStars: r.avgStars,
    coinsEarned: r.coinsEarned,
  };
}

type MonDb = {
  date: Date;
  platform: string;
  kind: string;
  itemKey: string;
  count: number;
  users: number;
  coinsSpent: number;
  adCount: number;
};
function toMonetizationRow(r: MonDb): MonetizationRow | null {
  const m = marketOf(r.platform);
  if (!m) return null;
  if (r.kind !== "skin" && r.kind !== "upgrade" && r.kind !== "foam_bomb") return null;
  return {
    date: isoDate(r.date),
    market: m,
    kind: r.kind as MonetizationKind,
    itemKey: r.itemKey,
    count: r.count,
    users: r.users,
    coinsSpent: r.coinsSpent,
    adCount: r.adCount,
  };
}

type MisDb = {
  date: Date;
  platform: string;
  missionType: string;
  claims: number;
  users: number;
  rewardCoins: number;
};
function toMissionRow(r: MisDb): MissionRow | null {
  const m = marketOf(r.platform);
  if (!m) return null;
  return {
    date: isoDate(r.date),
    market: m,
    missionType: r.missionType,
    claims: r.claims,
    users: r.users,
    rewardCoins: r.rewardCoins,
  };
}

type EconDb = {
  date: Date;
  platform: string;
  coinsFromLevels: number;
  coinsFromMissions: number;
  coinsToUpgrades: number;
  coinsToSkins: number;
  coinsToFoamBombs: number;
  foamBombAd: number;
  foamBombCoin: number;
};
function toEconomyRow(r: EconDb): EconomyRow | null {
  const m = marketOf(r.platform);
  if (!m) return null;
  return {
    date: isoDate(r.date),
    market: m,
    coinsFromLevels: r.coinsFromLevels,
    coinsFromMissions: r.coinsFromMissions,
    coinsToUpgrades: r.coinsToUpgrades,
    coinsToSkins: r.coinsToSkins,
    coinsToFoamBombs: r.coinsToFoamBombs,
    foamBombAd: r.foamBombAd,
    foamBombCoin: r.foamBombCoin,
  };
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-neutral-700">{title}</div>
      {children}
    </div>
  );
}

async function Overview({
  apps,
}: {
  apps: { id: string; slug: string; displayName: string }[];
}) {
  const items = await Promise.all(
    apps.map(async (a) => ({
      app: a,
      latest: (await prisma.appMetricDaily.findFirst({
        where: { appId: a.id },
        orderBy: { date: "desc" },
      })) as unknown as MetricDaily | null,
    })),
  );

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">앱</th>
            <th className="px-3 py-2">기준일</th>
            <th className="px-3 py-2 text-right">DAU</th>
            <th className="px-3 py-2 text-right">신규</th>
            <th className="px-3 py-2 text-right">D1</th>
            <th className="px-3 py-2 text-right">D7</th>
            <th className="px-3 py-2 text-right">광고노출</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ app, latest }) => (
            <tr key={app.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
              <td className="px-3 py-2">
                <Link href={`/analytics?app=${app.slug}`} className="font-medium hover:underline">
                  {app.displayName}
                </Link>
              </td>
              <td className="px-3 py-2 text-xs text-neutral-500">
                {latest ? isoDate(latest.date) : "—"}
              </td>
              <td className="px-3 py-2 text-right">{latest ? latest.dau : "—"}</td>
              <td className="px-3 py-2 text-right">{latest ? latest.newUsers : "—"}</td>
              <td className="px-3 py-2 text-right text-neutral-600">{latest ? pct(latest.d1Pct) : "—"}</td>
              <td className="px-3 py-2 text-right text-neutral-600">{latest ? pct(latest.d7Pct) : "—"}</td>
              <td className="px-3 py-2 text-right text-neutral-600">{latest ? latest.adImpressions : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TabLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded px-3 py-1.5 text-sm font-medium transition ${
        active ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
      }`}
    >
      {label}
    </Link>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
      {children}
    </div>
  );
}
