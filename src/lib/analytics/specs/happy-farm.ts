import type { AppContentSpec } from "@/lib/analytics/content-spec";

// happy-farm 컨텐츠 지표 스펙(작물/구역/온보딩·기능 퍼널/광고 placement).
// 이전 bespoke happy_farm_* 테이블/전용 SQL 을 범용 스펙으로 이관한 것. 지표 정의 단일
// 출처는 happy-farm docs/04-work/content-analytics.md, ad-analytics.md.
//   - crop_planted/crop_ready/crop_harvested(revenue,is_first_crop_harvest,area,crop),
//     auto_harvest_summary(harvested_count,total_gold,area,crop),
//     crop_of_the_day_harvested, seed_selected/first_seed_selected
//   - area_unlock_clicked/area_unlocked(cost)
//   - onboarding_step_view(step)/onboarding_skip/onboarding_stall/onboarding_complete
//   - prestige / research_node_unlocked(node_key) / collection_reward_claimed(reward_key)
//   - ad_reward_impression/click/completed/failed(reason)/ad_limit_blocked (placement)
// happy-farm 은 마켓 분해가 없다(플랫폼 마켓을 지표 축으로 쓰지 않음).
export const happyFarmContentSpec: AppContentSpec = {
  slug: "happy-farm",
  metrics: [
    { key: "onboarding_complete", label: "온보딩 완료", event: "onboarding_complete", agg: "count" },
    { key: "onboarding_skip", label: "온보딩 스킵", event: "onboarding_skip", agg: "count" },
    { key: "onboarding_stall", label: "온보딩 정체", event: "onboarding_stall", agg: "count" },
    { key: "prestige", label: "프레스티지", event: "prestige", agg: "count" },
  ],
  distributions: [
    { key: "research", label: "연구 노드 언락", event: "research_node_unlocked", param: "node_key", topN: 12 },
    { key: "collection", label: "컬렉션 보상", event: "collection_reward_claimed", param: "reward_key", topN: 12 },
  ],
  groups: [
    {
      key: "crop",
      label: "작물 지표",
      param: "crop",
      orderBy: "revenue",
      topN: 15,
      metrics: [
        { key: "planted", label: "심기", event: "crop_planted", agg: "count" },
        { key: "harvested", label: "직접 수확", event: "crop_harvested", agg: "count", where: [{ param: "harvest_source", op: "ne_or_unset", value: "auto" }] },
        { key: "autoHarvested", label: "자동 수확", event: "auto_harvest_summary", agg: "sum", param: "harvested_count" },
        { key: "harvesters", label: "수확자", event: ["crop_harvested", "auto_harvest_summary"], agg: "users", where: [{ param: "harvest_source", op: "ne_or_unset", value: "auto" }] },
        { key: "revenue", label: "직접 수확 매출", event: "crop_harvested", agg: "sum", param: "revenue", where: [{ param: "harvest_source", op: "ne_or_unset", value: "auto" }] },
        { key: "autoRevenue", label: "자동 수확 매출", event: "auto_harvest_summary", agg: "sum", param: "total_gold" },
        { key: "seedSelected", label: "씨앗 선택", event: ["seed_selected", "first_seed_selected"], agg: "count" },
        { key: "firstHarvests", label: "첫 수확", event: "crop_harvested", agg: "count", where: [{ param: "is_first_crop_harvest", op: "eq", value: 1 }, { param: "harvest_source", op: "ne_or_unset", value: "auto" }] },
        { key: "cotdHarvests", label: "오늘의 작물", event: "crop_of_the_day_harvested", agg: "count" },
      ],
      derived: [
        { key: "plantToHarvest", label: "심기→수확", num: "harvested", den: "planted" },
        { key: "revPerHarvest", label: "수확당 매출", num: "revenue", den: "harvested", scale: 1, unit: "" },
      ],
    },
    {
      key: "area",
      label: "구역 언락 퍼널",
      param: "area",
      orderBy: "unlockClicked",
      metrics: [
        { key: "unlockClicked", label: "언락 클릭", event: "area_unlock_clicked", agg: "count" },
        { key: "unlocked", label: "언락 완료", event: "area_unlocked", agg: "count" },
        { key: "planted", label: "심기", event: "crop_planted", agg: "count" },
        { key: "harvested", label: "직접 수확", event: "crop_harvested", agg: "count", where: [{ param: "harvest_source", op: "ne_or_unset", value: "auto" }] },
        { key: "autoHarvested", label: "자동 수확", event: "auto_harvest_summary", agg: "sum", param: "harvested_count" },
        { key: "unlockCostSum", label: "언락 비용", event: "area_unlocked", agg: "sum", param: "cost" },
      ],
      derived: [{ key: "unlockConv", label: "언락 전환", num: "unlocked", den: "unlockClicked" }],
    },
    {
      key: "onboarding",
      label: "온보딩 퍼널",
      param: "step",
      render: "funnel",
      order: ["selectSeed", "plant", "harvest", "unlock"],
      metrics: [
        { key: "views", label: "도달", event: "onboarding_step_view", agg: "count" },
        { key: "players", label: "사용자", event: "onboarding_step_view", agg: "users" },
      ],
    },
    {
      key: "adPlacement",
      label: "광고 placement 퍼널",
      param: "placement",
      orderBy: "impressions",
      metrics: [
        { key: "impressions", label: "노출", event: "ad_reward_impression", agg: "count" },
        { key: "clicks", label: "클릭", event: "ad_reward_click", agg: "count" },
        { key: "completes", label: "완료", event: "ad_reward_completed", agg: "count" },
        { key: "fails", label: "실패", event: "ad_reward_failed", agg: "count" },
        { key: "blocked", label: "차단", event: "ad_limit_blocked", agg: "count" },
      ],
      derived: [
        { key: "ctr", label: "CTR", num: "clicks", den: "impressions" },
        { key: "completeRate", label: "완료율", num: "completes", den: "clicks" },
      ],
    },
  ],
};
