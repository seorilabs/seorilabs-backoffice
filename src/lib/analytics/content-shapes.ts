// 콘텐츠 세부 지표의 순수 타입 + 시장(market) 매핑 + 집계 헬퍼.
// 무거운 의존성 없음 → 소스 어댑터(GA4/자체서버), 수집부, 대시보드, 테스트가 공유한다.
//
// market = 배포 시장. GA4 platform 과 1:1: ANDROID=Google Play, IOS=App Store, WEB=AIT.
// 콘텐츠 지표는 시장별 1행으로 저장하고, "통합" 뷰는 시장 합산으로 파생한다(이벤트
// 카운트는 가산적). 평균값(클리어시간/별)은 완료수 가중 재결합으로 통합 평균을 낸다.

export type Market = "android" | "ios" | "web";

export const MARKETS: readonly Market[] = ["android", "ios", "web"] as const;

/** 시장 표시 라벨(대시보드 탭/범례). */
export const MARKET_LABEL: Record<Market, string> = {
  android: "Google Play",
  ios: "App Store",
  web: "AIT",
};

/** GA4 platform(대문자) → market. 미지원 platform 은 null(집계 제외). */
export function marketOf(platform: string): Market | null {
  switch (platform.trim().toUpperCase()) {
    case "ANDROID":
      return "android";
    case "IOS":
      return "ios";
    case "WEB":
      return "web";
    default:
      return null;
  }
}

// ── 소스/저장 캐노니컬 행 ────────────────────────────────────────────────────
// 소스 어댑터가 내는 행 = 그대로 typed 모델로 upsert 되는 형태(id/collectedAt 제외).
// date 는 "YYYY-MM-DD", market 은 이미 해석된 값.

/** 레벨 퍼널: (날짜×시장×레벨). 이탈 = starts - completes. */
export interface LevelMetricRow {
  date: string;
  market: Market;
  level: number;
  starts: number; // level_start 이벤트 수
  completes: number; // level_complete 이벤트 수
  players: number; // level_start 고유 사용자
  avgClearSec: number | null; // level_complete time_sec 평균
  avgStars: number | null; // level_complete stars 평균
  coinsEarned: number; // level_complete coins_earned 합
}

export type MonetizationKind = "skin" | "upgrade" | "foam_bomb";

/** 수익화 분포: (날짜×시장×종류×아이템). */
export interface MonetizationRow {
  date: string;
  market: Market;
  kind: MonetizationKind;
  itemKey: string; // skin_id / tool / source(ad|coins)
  count: number; // 이벤트 수
  users: number; // 고유 사용자
  coinsSpent: number; // cost 합(코인 소비)
  adCount: number; // 광고 소스 수(foam_bomb source=ad)
}

/** 미션·리텐션 훅: (날짜×시장×미션타입). */
export interface MissionRow {
  date: string;
  market: Market;
  missionType: string;
  claims: number;
  users: number;
  rewardCoins: number;
}

/** 경제/재화 흐름: (날짜×시장) 소스/싱크 합계. */
export interface EconomyRow {
  date: string;
  market: Market;
  coinsFromLevels: number;
  coinsFromMissions: number;
  coinsToUpgrades: number;
  coinsToSkins: number;
  coinsToFoamBombs: number;
  foamBombAd: number;
  foamBombCoin: number;
}

// ── 소스 포트 ────────────────────────────────────────────────────────────────
// 콘텐츠 지표 소스 추상화. 지금은 GA4/BigQuery 어댑터가 구현하고, 나중에 자체 지표
// 서버가 생기면 같은 포트를 구현해 수집부·스키마·대시보드 변경 없이 교체한다.

/** 소스가 앱을 식별하는 데 필요한 최소 필드(GA4 는 dataset, 자체서버는 slug 사용). */
export interface ContentSourceApp {
  slug: string;
  firebaseProject: string | null;
  ga4Dataset: string | null;
}

/** 조회 윈도우. GA4 는 events_YYYYMMDD 접미사 범위로 쓴다. */
export interface ContentDateWindow {
  start: string; // "YYYYMMDD"
  end: string; // "YYYYMMDD"
}

export interface ContentMetricsSource {
  /** 진단/로그용 소스 이름(e.g. "ga4-bigquery"). */
  readonly name: string;
  queryLevels(app: ContentSourceApp, window: ContentDateWindow): Promise<LevelMetricRow[]>;
  queryMonetization(app: ContentSourceApp, window: ContentDateWindow): Promise<MonetizationRow[]>;
  queryMissions(app: ContentSourceApp, window: ContentDateWindow): Promise<MissionRow[]>;
  queryEconomy(app: ContentSourceApp, window: ContentDateWindow): Promise<EconomyRow[]>;
}

// ── 순수 집계 헬퍼(대시보드 롤업 + 통합/개별 파생) ────────────────────────────

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 완료율(%). starts 0 이면 null. */
export function completionRate(starts: number, completes: number): number | null {
  if (starts <= 0) return null;
  return round1((completes / starts) * 100);
}

/** 완료수 가중 평균(통합 평균 재결합). 유효 표본이 없으면 null. */
export function weightedAvg(
  rows: { value: number | null; weight: number }[],
): number | null {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    if (r.value == null || r.weight <= 0) continue;
    num += r.value * r.weight;
    den += r.weight;
  }
  if (den <= 0) return null;
  return round1(num / den);
}

/** market 필터: "all" 이면 전체, 아니면 해당 시장만. */
export function filterByMarket<T extends { market: Market }>(
  rows: T[],
  market: Market | "all",
): T[] {
  return market === "all" ? rows : rows.filter((r) => r.market === market);
}

/** 롤업된 레벨 퍼널 1행(윈도우/시장 합산 결과). */
export interface LevelTotal {
  level: number;
  starts: number;
  completes: number;
  players: number;
  avgClearSec: number | null;
  avgStars: number | null;
  coinsEarned: number;
  completionRate: number | null;
}

/** 여러 날짜×시장 레벨행 → 레벨별 합계(레벨 오름차순). 평균은 완료수 가중. */
export function rollupLevels(rows: LevelMetricRow[]): LevelTotal[] {
  const byLevel = new Map<number, LevelMetricRow[]>();
  for (const r of rows) {
    (byLevel.get(r.level) ?? byLevel.set(r.level, []).get(r.level)!).push(r);
  }
  const out: LevelTotal[] = [];
  for (const [level, group] of byLevel) {
    const starts = sum(group, (g) => g.starts);
    const completes = sum(group, (g) => g.completes);
    out.push({
      level,
      starts,
      completes,
      players: sum(group, (g) => g.players),
      avgClearSec: weightedAvg(group.map((g) => ({ value: g.avgClearSec, weight: g.completes }))),
      avgStars: weightedAvg(group.map((g) => ({ value: g.avgStars, weight: g.completes }))),
      coinsEarned: sum(group, (g) => g.coinsEarned),
      completionRate: completionRate(starts, completes),
    });
  }
  return out.sort((a, b) => a.level - b.level);
}

/** 롤업된 수익화 1행(종류×아이템 합계). */
export interface MonetizationTotal {
  kind: MonetizationKind;
  itemKey: string;
  count: number;
  users: number;
  coinsSpent: number;
  adCount: number;
}

/** 여러 날짜×시장 수익화행 → (종류,아이템)별 합계. count 내림차순. */
export function rollupMonetization(rows: MonetizationRow[]): MonetizationTotal[] {
  const byKey = new Map<string, MonetizationRow[]>();
  for (const r of rows) {
    const k = `${r.kind} ${r.itemKey}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }
  const out: MonetizationTotal[] = [];
  for (const group of byKey.values()) {
    out.push({
      kind: group[0].kind,
      itemKey: group[0].itemKey,
      count: sum(group, (g) => g.count),
      users: sum(group, (g) => g.users),
      coinsSpent: sum(group, (g) => g.coinsSpent),
      adCount: sum(group, (g) => g.adCount),
    });
  }
  return out.sort((a, b) => b.count - a.count || a.itemKey.localeCompare(b.itemKey));
}

/** 롤업된 미션 1행. */
export interface MissionTotal {
  missionType: string;
  claims: number;
  users: number;
  rewardCoins: number;
}

export function rollupMissions(rows: MissionRow[]): MissionTotal[] {
  const byType = new Map<string, MissionRow[]>();
  for (const r of rows) {
    (byType.get(r.missionType) ?? byType.set(r.missionType, []).get(r.missionType)!).push(r);
  }
  const out: MissionTotal[] = [];
  for (const group of byType.values()) {
    out.push({
      missionType: group[0].missionType,
      claims: sum(group, (g) => g.claims),
      users: sum(group, (g) => g.users),
      rewardCoins: sum(group, (g) => g.rewardCoins),
    });
  }
  return out.sort((a, b) => b.claims - a.claims || a.missionType.localeCompare(b.missionType));
}

/** 경제 소스/싱크 합계 + 순증(sources - sinks). */
export interface EconomyTotal {
  coinsFromLevels: number;
  coinsFromMissions: number;
  coinsToUpgrades: number;
  coinsToSkins: number;
  coinsToFoamBombs: number;
  foamBombAd: number;
  foamBombCoin: number;
  sources: number; // 총 획득
  sinks: number; // 총 소비
  net: number; // 순증(획득-소비)
}

export function rollupEconomy(rows: EconomyRow[]): EconomyTotal {
  const t = {
    coinsFromLevels: sum(rows, (r) => r.coinsFromLevels),
    coinsFromMissions: sum(rows, (r) => r.coinsFromMissions),
    coinsToUpgrades: sum(rows, (r) => r.coinsToUpgrades),
    coinsToSkins: sum(rows, (r) => r.coinsToSkins),
    coinsToFoamBombs: sum(rows, (r) => r.coinsToFoamBombs),
    foamBombAd: sum(rows, (r) => r.foamBombAd),
    foamBombCoin: sum(rows, (r) => r.foamBombCoin),
  };
  const sources = t.coinsFromLevels + t.coinsFromMissions;
  const sinks = t.coinsToUpgrades + t.coinsToSkins + t.coinsToFoamBombs;
  return { ...t, sources, sinks, net: sources - sinks };
}

function sum<T>(rows: T[], pick: (r: T) => number): number {
  let n = 0;
  for (const r of rows) n += pick(r);
  return n;
}
