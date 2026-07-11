import type { AppContentSpec } from "@/lib/analytics/content-spec";

// lucid-chess 컨텐츠 지표 스펙. 이벤트/파라미터는 게임 레포의 컨텐츠 이벤트 카탈로그
// (packages/product-core/src/domain/content_events.gd)와 계약을 공유한다.
//   - game_end: outcome/result_state/winner/move_count/duration_sec/hints_used/blunder_*
//   - game_abandon: outcome=abandon/move_count/duration_sec/reason
//   - hint_used / blunder_warning_shown / blunder_warning_overridden / streak_claim / game_start
//   - difficulty_select / theme_select / player_color_select
export const lucidChessContentSpec: AppContentSpec = {
  slug: "lucid-chess",
  distributions: [
    {
      key: "outcome",
      label: "게임 결과",
      event: "game_end",
      param: "outcome",
      valueLabels: { win: "승", loss: "패", draw: "무", unknown: "기타", "(unset)": "미상" },
    },
    { key: "difficulty", label: "난이도", event: "game_end", param: "difficulty", topN: 9 },
    { key: "player_color", label: "플레이어 색", event: "game_end", param: "player_color", topN: 3 },
    { key: "theme", label: "보드 테마 선택", event: "theme_select", param: "theme" },
    { key: "abandon_reason", label: "이탈 사유", event: "game_abandon", param: "reason" },
  ],
  counters: [
    { key: "game_start", label: "게임 시작", event: "game_start" },
    { key: "hint_used", label: "힌트 사용", event: "hint_used" },
    { key: "blunder_shown", label: "블런더 경고 노출", event: "blunder_warning_shown" },
    { key: "blunder_overridden", label: "블런더 경고 무시", event: "blunder_warning_overridden" },
    { key: "streak_claim", label: "스트릭 체크인", event: "streak_claim" },
  ],
  measures: [
    { key: "avg_moves", label: "평균 수순", event: "game_end", param: "move_count", agg: "avg", unit: "수" },
    { key: "avg_duration", label: "평균 대국시간", event: "game_end", param: "duration_sec", agg: "avg", unit: "초" },
    { key: "avg_hints", label: "게임당 힌트", event: "game_end", param: "hints_used", agg: "avg", unit: "회", round: 2 },
  ],
};
