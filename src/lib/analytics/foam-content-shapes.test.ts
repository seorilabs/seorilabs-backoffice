import assert from "node:assert/strict";
import test from "node:test";
import {
  marketOf,
  completionRate,
  weightedAvg,
  filterByMarket,
  rollupLevels,
  rollupMonetization,
  rollupMissions,
  rollupEconomy,
  type LevelMetricRow,
  type MonetizationRow,
  type MissionRow,
  type EconomyRow,
} from "@/lib/analytics/foam-content-shapes";

test("marketOf: GA4 platform → market, 미지원은 null", () => {
  assert.equal(marketOf("ANDROID"), "android");
  assert.equal(marketOf("ios"), "ios");
  assert.equal(marketOf(" WEB "), "web");
  assert.equal(marketOf("TIZEN"), null);
  assert.equal(marketOf(""), null);
});

// 소스 어댑터 계약: foam-content-source 의 SQL 은 `LOWER(platform) AS market` 로
// 소문자('android'|'ios'|'web')를 내보내고, 그 값이 marketOf 를 그대로 통과해야 한다.
// (marketOf 가 입력을 대문자 정규화하므로 소문자 코드 경로도 null 로 떨어지지 않음.)
test("marketOf: SQL 이 내보내는 소문자 platform 경로도 정상 매핑", () => {
  assert.equal(marketOf("android"), "android");
  assert.equal(marketOf("ios"), "ios");
  assert.equal(marketOf("web"), "web");
});

test("completionRate: 완료/시작 %, starts 0 이면 null", () => {
  assert.equal(completionRate(200, 150), 75);
  assert.equal(completionRate(0, 0), null);
  assert.equal(completionRate(3, 1), 33.3);
});

test("weightedAvg: 완료수 가중, 표본 없으면 null", () => {
  // (60*10 + 80*30) / 40 = 75
  assert.equal(weightedAvg([{ value: 60, weight: 10 }, { value: 80, weight: 30 }]), 75);
  assert.equal(weightedAvg([{ value: 50, weight: 0 }]), null);
  assert.equal(weightedAvg([{ value: null, weight: 10 }]), null);
});

test("filterByMarket: all 은 전체, 특정 시장은 필터", () => {
  const rows = [{ market: "android" as const }, { market: "ios" as const }];
  assert.equal(filterByMarket(rows, "all").length, 2);
  assert.deepEqual(filterByMarket(rows, "ios"), [{ market: "ios" }]);
});

const lvl = (
  market: LevelMetricRow["market"],
  level: number,
  starts: number,
  completes: number,
  avgClearSec: number | null,
): LevelMetricRow => ({
  date: "2026-07-10",
  market,
  level,
  starts,
  completes,
  players: starts,
  avgClearSec,
  avgStars: 2.5,
  coinsEarned: completes * 10,
});

test("rollupLevels: 시장 합산 + 완료수 가중 평균 + 완료율", () => {
  const rows = [
    lvl("android", 1, 100, 80, 60),
    lvl("ios", 1, 100, 20, 90), // 같은 레벨 다른 시장 → 통합
    lvl("android", 2, 50, 10, 120),
  ];
  const out = rollupLevels(rows);
  assert.equal(out.length, 2);
  const l1 = out.find((r) => r.level === 1)!;
  assert.equal(l1.starts, 200);
  assert.equal(l1.completes, 100);
  assert.equal(l1.completionRate, 50);
  // (60*80 + 90*20)/100 = 66
  assert.equal(l1.avgClearSec, 66);
  assert.equal(l1.coinsEarned, 1000);
  // 레벨 오름차순
  assert.deepEqual(out.map((r) => r.level), [1, 2]);
});

test("rollupMonetization: (종류,아이템) 합산 + count 내림차순", () => {
  const rows: MonetizationRow[] = [
    { date: "d", market: "android", kind: "skin", itemKey: "coral", count: 5, users: 4, coinsSpent: 400, adCount: 0 },
    { date: "d", market: "ios", kind: "skin", itemKey: "coral", count: 3, users: 3, coinsSpent: 240, adCount: 0 },
    { date: "d", market: "web", kind: "foam_bomb", itemKey: "ad", count: 20, users: 10, coinsSpent: 0, adCount: 20 },
  ];
  const out = rollupMonetization(rows);
  assert.equal(out[0].itemKey, "ad"); // count 20 최상단
  const coral = out.find((r) => r.kind === "skin" && r.itemKey === "coral")!;
  assert.equal(coral.count, 8);
  assert.equal(coral.coinsSpent, 640);
});

test("rollupMissions: 미션타입 합산 + claims 내림차순", () => {
  const rows: MissionRow[] = [
    { date: "d", market: "android", missionType: "dust", claims: 10, users: 8, rewardCoins: 500 },
    { date: "d", market: "ios", missionType: "dust", claims: 5, users: 5, rewardCoins: 250 },
    { date: "d", market: "web", missionType: "leaf", claims: 20, users: 15, rewardCoins: 1000 },
  ];
  const out = rollupMissions(rows);
  assert.equal(out[0].missionType, "leaf");
  assert.equal(out.find((r) => r.missionType === "dust")!.claims, 15);
});

test("rollupEconomy: 소스/싱크 합계 + 순증", () => {
  const rows: EconomyRow[] = [
    {
      date: "d",
      market: "android",
      coinsFromLevels: 1000,
      coinsFromMissions: 200,
      coinsToUpgrades: 300,
      coinsToSkins: 400,
      coinsToFoamBombs: 100,
      foamBombAd: 5,
      foamBombCoin: 2,
    },
  ];
  const e = rollupEconomy(rows);
  assert.equal(e.sources, 1200);
  assert.equal(e.sinks, 800);
  assert.equal(e.net, 400);
  assert.equal(e.foamBombAd, 5);
});
