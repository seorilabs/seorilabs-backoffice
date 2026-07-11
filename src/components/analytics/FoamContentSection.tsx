import { prisma } from "@/lib/prisma";
import { isoDate, latestClosedDay, dateWindow, parseIsoDate } from "@/lib/ga4/datasets";
import {
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
} from "@/lib/analytics/foam-content-shapes";
import {
  MarketTabs,
  LevelFunnel,
  MonetizationPanel,
  MissionPanel,
  EconomyPanel,
} from "@/components/analytics/ContentPanels";

// foam-party 콘텐츠 세부 지표 섹션(서버 컴포넌트). 최근 CONTENT_WINDOW 일 typed 행을
// 시장 필터 + 롤업해 레벨 퍼널/수익화/미션/경제 패널로 렌더한다. 마켓 통합·개별 탭 제공.
// (ContentMetricsSection 디스패처가 slug=foam-party 일 때 이 컴포넌트를 고른다.)

const CONTENT_WINDOW = 28;

export async function FoamContentSection({
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
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
        아직 수집된 콘텐츠 지표가 없습니다. (레벨/수익화/미션/경제 이벤트 수집 후 표시됩니다)
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-neutral-400">
          {marketLabel} · 최근 {CONTENT_WINDOW}일 합계
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-neutral-700">{title}</div>
      {children}
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
