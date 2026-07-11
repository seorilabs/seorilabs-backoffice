import type { AppContentSpec } from "@/lib/analytics/content-spec";

// foam-party 컨텐츠 지표 스펙(레벨/수익화/미션/경제 + 마켓 통합·개별).
// 이전 bespoke app_level/monetization/mission/economy_daily 테이블/전용 SQL 을 범용 스펙으로
// 이관한 것. 마켓 = 플랫폼(android=Google Play, ios=App Store, web=AIT). platform 으로 해석.
//   - level_start / level_complete(level,time_sec,stars,coins_earned)
//   - skin_purchase(skin_id,cost) / upgrade_purchase(tool,cost) / foam_bomb_use(source,cost)
//   - daily_mission_claim(mission_type,reward)
export const foamPartyContentSpec: AppContentSpec = {
  slug: "foam-party",
  market: {
    platformMap: { android: "android", ios: "ios", web: "web" },
    values: [
      { key: "android", label: "Google Play" },
      { key: "ios", label: "App Store" },
      { key: "web", label: "AIT" },
    ],
  },
  metrics: [
    // 경제/재화 흐름(소스=획득, 싱크=소비).
    { key: "coinsFromLevels", label: "레벨 획득 코인", event: "level_complete", agg: "sum", param: "coins_earned" },
    { key: "coinsFromMissions", label: "미션 획득 코인", event: "daily_mission_claim", agg: "sum", param: "reward" },
    { key: "coinsToUpgrades", label: "업그레이드 소비", event: "upgrade_purchase", agg: "sum", param: "cost" },
    { key: "coinsToSkins", label: "스킨 소비", event: "skin_purchase", agg: "sum", param: "cost" },
    { key: "coinsToFoamBombs", label: "폼밤 소비(코인)", event: "foam_bomb_use", agg: "sum", param: "cost", where: [{ param: "source", op: "eq", value: "coins" }] },
    { key: "foamBombAd", label: "폼밤(광고)", event: "foam_bomb_use", agg: "count", where: [{ param: "source", op: "eq", value: "ad" }] },
    { key: "foamBombCoin", label: "폼밤(코인)", event: "foam_bomb_use", agg: "count", where: [{ param: "source", op: "eq", value: "coins" }] },
  ],
  groups: [
    {
      key: "level",
      label: "레벨 퍼널",
      param: "level",
      orderBy: "starts",
      topN: 30,
      metrics: [
        { key: "starts", label: "시작", event: "level_start", agg: "count" },
        { key: "completes", label: "완료", event: "level_complete", agg: "count" },
        { key: "players", label: "플레이어", event: "level_start", agg: "users" },
        { key: "avgClearSec", label: "평균 클리어", event: "level_complete", agg: "avg", param: "time_sec", unit: "초" },
        { key: "avgStars", label: "평균 별", event: "level_complete", agg: "avg", param: "stars", unit: "★" },
        { key: "coinsEarned", label: "획득 코인", event: "level_complete", agg: "sum", param: "coins_earned" },
      ],
      derived: [{ key: "completionRate", label: "완료율", num: "completes", den: "starts" }],
    },
    {
      key: "skin",
      label: "스킨 구매",
      param: "skin_id",
      orderBy: "count",
      metrics: [
        { key: "count", label: "구매", event: "skin_purchase", agg: "count" },
        { key: "users", label: "사용자", event: "skin_purchase", agg: "users" },
        { key: "coinsSpent", label: "코인 소비", event: "skin_purchase", agg: "sum", param: "cost" },
      ],
    },
    {
      key: "upgrade",
      label: "업그레이드",
      param: "tool",
      orderBy: "count",
      metrics: [
        { key: "count", label: "구매", event: "upgrade_purchase", agg: "count" },
        { key: "users", label: "사용자", event: "upgrade_purchase", agg: "users" },
        { key: "coinsSpent", label: "코인 소비", event: "upgrade_purchase", agg: "sum", param: "cost" },
      ],
    },
    {
      key: "mission",
      label: "데일리 미션",
      param: "mission_type",
      orderBy: "claims",
      metrics: [
        { key: "claims", label: "클레임", event: "daily_mission_claim", agg: "count" },
        { key: "users", label: "사용자", event: "daily_mission_claim", agg: "users" },
        { key: "rewardCoins", label: "보상 코인", event: "daily_mission_claim", agg: "sum", param: "reward" },
      ],
    },
  ],
};
