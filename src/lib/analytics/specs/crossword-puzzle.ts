import type { AppContentSpec } from "@/lib/analytics/content-spec";

// crossword-puzzle(가로세로 낱말) 컨텐츠 지표 스펙(완료 퍼널·풀이 성과·힌트/보조·난이도).
// 이전 bespoke crossword_metric_daily 테이블/전용 SQL 을 범용 스펙으로 이관한 것.
// 마켓 = market 파라미터 우선(앱이 직접 전송), 없으면 platform 폴백.
//   - game_puzzle_start / game_first_input / game_progress / game_puzzle_complete / game_puzzle_abandon
//   - game_hint_use(hint_type=hint|reveal_word|stuck_hint) / game_assist_ad(result=request|reward)
//   - game_puzzle_complete: solve_time_sec, no_hint, first_try, difficulty
// no_hint/first_try 는 불리언 파라미터 — op:"truthy" 로 string 'true'/'1' 과 int 1 을 모두 인정.
export const crosswordPuzzleContentSpec: AppContentSpec = {
  slug: "crossword-puzzle",
  market: {
    param: "market",
    platformMap: { android: "google-play", ios: "app-store", web: "apps-in-toss" },
    values: [
      { key: "apps-in-toss", label: "AppsInToss" },
      { key: "google-play", label: "Google Play" },
      { key: "app-store", label: "App Store" },
    ],
  },
  metrics: [
    // 완료 퍼널(카운트).
    { key: "starts", label: "시작", event: "game_puzzle_start", agg: "count" },
    { key: "firstInputs", label: "첫 입력", event: "game_first_input", agg: "count" },
    { key: "progressReaches", label: "진행 도달", event: "game_progress", agg: "count" },
    { key: "completes", label: "완료", event: "game_puzzle_complete", agg: "count" },
    { key: "abandons", label: "이탈", event: "game_puzzle_abandon", agg: "count" },
    // 고유 사용자.
    { key: "players", label: "플레이어", event: "game_puzzle_start", agg: "users" },
    { key: "completePlayers", label: "완료 사용자", event: "game_puzzle_complete", agg: "users" },
    // 풀이 성과.
    { key: "avgSolveTime", label: "평균 풀이시간", event: "game_puzzle_complete", agg: "avg", param: "solve_time_sec", unit: "초" },
    { key: "noHintCompletes", label: "노힌트 완료", event: "game_puzzle_complete", agg: "count", where: [{ param: "no_hint", op: "truthy" }] },
    { key: "firstTryCompletes", label: "첫도전 완료", event: "game_puzzle_complete", agg: "count", where: [{ param: "first_try", op: "truthy" }] },
    // 힌트/보조.
    { key: "hintUses", label: "힌트", event: "game_hint_use", agg: "count", where: [{ param: "hint_type", op: "eq", value: "hint" }] },
    { key: "revealUses", label: "정답 보기", event: "game_hint_use", agg: "count", where: [{ param: "hint_type", op: "eq", value: "reveal_word" }] },
    { key: "stuckHintUses", label: "막힘 힌트", event: "game_hint_use", agg: "count", where: [{ param: "hint_type", op: "eq", value: "stuck_hint" }] },
    { key: "assistAdRequests", label: "광고보조 요청", event: "game_assist_ad", agg: "count", where: [{ param: "result", op: "eq", value: "request" }] },
    { key: "assistAdRewards", label: "광고보조 보상", event: "game_assist_ad", agg: "count", where: [{ param: "result", op: "eq", value: "reward" }] },
  ],
  derived: [
    { key: "completionRate", label: "완료율", num: "completes", den: "starts" },
    { key: "noHintRate", label: "노힌트 완료율", num: "noHintCompletes", den: "completes" },
    { key: "firstTryRate", label: "첫도전 완료율", num: "firstTryCompletes", den: "completes" },
  ],
  groups: [
    {
      key: "difficulty",
      label: "난이도별",
      param: "difficulty",
      order: ["easy", "normal", "hard"],
      valueLabels: { easy: "쉬움", normal: "보통", hard: "어려움" },
      metrics: [
        { key: "starts", label: "시작", event: "game_puzzle_start", agg: "count" },
        { key: "completes", label: "완료", event: "game_puzzle_complete", agg: "count" },
        { key: "avgSolveTime", label: "평균 풀이", event: "game_puzzle_complete", agg: "avg", param: "solve_time_sec", unit: "초" },
        { key: "players", label: "플레이어", event: "game_puzzle_start", agg: "users" },
      ],
      derived: [{ key: "completionRate", label: "완료율", num: "completes", den: "starts" }],
    },
  ],
};
