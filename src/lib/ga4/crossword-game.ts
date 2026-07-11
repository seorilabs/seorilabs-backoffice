import type { Ga4Target } from "@/lib/ga4/datasets";
import { runQuery, num } from "@/lib/ga4/bigquery";

// 가로세로 낱말 퍼즐 "게임 세부 지표" BigQuery 조회(crossword 전용, 격리 파일).
// 앱(crossword-puzzle)이 core gameAnalytics 계약으로 보내는 game_* 이벤트를 GA4 export
// 에서 날짜×마켓×난이도로 집계한다. 여러 게임 지표가 동시에 백오피스에 붙으므로, 다른
// 게임과 충돌하지 않도록 crossword 코드는 이 파일에 모으고 공유 파일 수정은 최소화한다.
//
// 마켓(market): 앱이 실어 보내는 `market` 파라미터를 우선 쓰고, 아직 그 파라미터가 없는
// (구버전) 이벤트는 GA4 `platform`으로 폴백 매핑한다(WEB→apps-in-toss, ANDROID→google-play,
// IOS→app-store). 마켓통합/마켓개별을 한 쿼리로 얻기 위해 GROUPING SETS로 소계를 함께 낸다.

/** 앱이 core gameAnalytics로 전송하는 게임 이벤트 이름(계약과 1:1). */
export const CROSSWORD_GAME_EVENTS = [
  "game_puzzle_start",
  "game_first_input",
  "game_progress",
  "game_puzzle_complete",
  "game_puzzle_abandon",
  "game_hint_use",
  "game_assist_ad",
] as const;

/** GROUPING SETS 조회의 한 행. market/difficulty 가 NULL 이면 해당 차원의 소계(rollup) 행. */
export interface CrosswordGameRow {
  date: string; // "YYYY-MM-DD"
  market: string | null; // null → 전체 마켓 합계
  difficulty: string | null; // null → 전체 난이도 합계
  starts: number;
  firstInputs: number;
  progressReaches: number;
  completes: number;
  abandons: number;
  solveTimeSumSec: number;
  noHintCompletes: number;
  firstTryCompletes: number;
  hintUses: number;
  revealUses: number;
  stuckHintUses: number;
  assistAdRequests: number;
  assistAdRewards: number;
  players: number; // 고유 사용자(그룹 단위로 재계산됨 — rollup 행도 정확)
  completePlayers: number;
}

// event_params 추출 헬퍼(문자열 SQL). 기존 bigquery.ts 관례와 동일하게 상수로 둔다.
function pStr(key: string): string {
  return `(SELECT value.string_value FROM UNNEST(event_params) WHERE key = '${key}')`;
}
function pDbl(key: string): string {
  return `(SELECT COALESCE(value.double_value, value.int_value) FROM UNNEST(event_params) WHERE key = '${key}')`;
}
// 불리언 파라미터: 웹/RN Firebase SDK가 string 'true'/'false' 또는 int 1/0 로 export 할 수
// 있어 둘 다 허용한다. 없으면 FALSE.
function pBool(key: string): string {
  return `COALESCE(
    (SELECT LOWER(value.string_value) IN ('true', '1') FROM UNNEST(event_params) WHERE key = '${key}'),
    (SELECT value.int_value = 1 FROM UNNEST(event_params) WHERE key = '${key}'),
    FALSE)`;
}

const MARKET_EXPR = `COALESCE(
  ${pStr("market")},
  CASE UPPER(platform)
    WHEN 'ANDROID' THEN 'google-play'
    WHEN 'IOS' THEN 'app-store'
    WHEN 'WEB' THEN 'apps-in-toss'
    ELSE 'unknown'
  END)`;

/**
 * 날짜×마켓×난이도 게임 지표. start/end 는 "YYYYMMDD". GROUPING SETS로
 * (날짜·마켓·난이도) / (날짜·마켓) / (날짜·난이도) / (날짜) 소계를 한 번에 낸다.
 * 카운트는 합산 가능하고, COUNT(DISTINCT)는 각 그룹에서 재계산되어 rollup 행도 정확하다.
 */
export async function queryCrosswordGameMetrics(
  target: Ga4Target,
  start: string,
  end: string,
): Promise<CrosswordGameRow[]> {
  const from = `\`${target.firebaseProject}.${target.dataset}.events_*\``;
  const eventList = CROSSWORD_GAME_EVENTS.map((e) => `'${e}'`).join(", ");
  const sql = `
    WITH ev AS (
      SELECT
        FORMAT_DATE('%Y-%m-%d', PARSE_DATE('%Y%m%d', event_date)) AS date,
        user_pseudo_id,
        event_name,
        ${MARKET_EXPR} AS market,
        ${pStr("difficulty")} AS difficulty,
        ${pDbl("solve_time_sec")} AS solve_time_sec,
        ${pBool("no_hint")} AS no_hint,
        ${pBool("first_try")} AS first_try,
        ${pStr("hint_type")} AS hint_type,
        ${pStr("result")} AS assist_result
      FROM ${from}
      WHERE _TABLE_SUFFIX BETWEEN '${start}' AND '${end}'
        AND event_name IN (${eventList})
    )
    SELECT
      date,
      market,
      difficulty,
      COUNTIF(event_name = 'game_puzzle_start') AS starts,
      COUNTIF(event_name = 'game_first_input') AS first_inputs,
      COUNTIF(event_name = 'game_progress') AS progress_reaches,
      COUNTIF(event_name = 'game_puzzle_complete') AS completes,
      COUNTIF(event_name = 'game_puzzle_abandon') AS abandons,
      SUM(IF(event_name = 'game_puzzle_complete', solve_time_sec, 0)) AS solve_time_sum_sec,
      COUNTIF(event_name = 'game_puzzle_complete' AND no_hint) AS no_hint_completes,
      COUNTIF(event_name = 'game_puzzle_complete' AND first_try) AS first_try_completes,
      COUNTIF(event_name = 'game_hint_use' AND hint_type = 'hint') AS hint_uses,
      COUNTIF(event_name = 'game_hint_use' AND hint_type = 'reveal_word') AS reveal_uses,
      COUNTIF(event_name = 'game_hint_use' AND hint_type = 'stuck_hint') AS stuck_hint_uses,
      COUNTIF(event_name = 'game_assist_ad' AND assist_result = 'request') AS assist_ad_requests,
      COUNTIF(event_name = 'game_assist_ad' AND assist_result = 'reward') AS assist_ad_rewards,
      COUNT(DISTINCT user_pseudo_id) AS players,
      COUNT(DISTINCT IF(event_name = 'game_puzzle_complete', user_pseudo_id, NULL)) AS complete_players
    FROM ev
    GROUP BY GROUPING SETS (
      (date, market, difficulty),
      (date, market),
      (date, difficulty),
      (date)
    )
    ORDER BY date`;

  const rows = await runQuery<Record<string, unknown>>(
    target.firebaseProject,
    target.dataset,
    sql,
  );

  return rows.map((r) => ({
    date: String(r.date),
    market: r.market == null ? null : String(r.market),
    difficulty: r.difficulty == null ? null : String(r.difficulty),
    starts: num(r.starts),
    firstInputs: num(r.first_inputs),
    progressReaches: num(r.progress_reaches),
    completes: num(r.completes),
    abandons: num(r.abandons),
    solveTimeSumSec: num(r.solve_time_sum_sec),
    noHintCompletes: num(r.no_hint_completes),
    firstTryCompletes: num(r.first_try_completes),
    hintUses: num(r.hint_uses),
    revealUses: num(r.reveal_uses),
    stuckHintUses: num(r.stuck_hint_uses),
    assistAdRequests: num(r.assist_ad_requests),
    assistAdRewards: num(r.assist_ad_rewards),
    players: num(r.players),
    completePlayers: num(r.complete_players),
  }));
}
