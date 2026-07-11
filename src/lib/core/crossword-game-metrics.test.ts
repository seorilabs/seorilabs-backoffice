import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleCrosswordDaily,
  CROSSWORD_MARKET_ALL,
} from "./crossword-game-metrics";
import type { CrosswordGameRow } from "@/lib/ga4/crossword-game";

function row(over: Partial<CrosswordGameRow>): CrosswordGameRow {
  return {
    date: "2026-07-10",
    market: null,
    difficulty: null,
    starts: 0,
    firstInputs: 0,
    progressReaches: 0,
    completes: 0,
    abandons: 0,
    solveTimeSumSec: 0,
    noHintCompletes: 0,
    firstTryCompletes: 0,
    hintUses: 0,
    revealUses: 0,
    stuckHintUses: 0,
    assistAdRequests: 0,
    assistAdRewards: 0,
    players: 0,
    completePlayers: 0,
    ...over,
  };
}

test("마켓통합('all')과 마켓개별 행을 모두 만든다", () => {
  const rows: CrosswordGameRow[] = [
    // (date) 전체 소계
    row({ starts: 100, completes: 60, solveTimeSumSec: 6000, players: 80 }),
    // (date, market) 마켓 소계
    row({ market: "apps-in-toss", starts: 70, completes: 40, solveTimeSumSec: 3600, players: 55 }),
    row({ market: "google-play", starts: 30, completes: 20, solveTimeSumSec: 2400, players: 25 }),
  ];

  const records = assembleCrosswordDaily(rows);
  const all = records.find((r) => r.market === CROSSWORD_MARKET_ALL);
  const ait = records.find((r) => r.market === "apps-in-toss");
  const gp = records.find((r) => r.market === "google-play");

  assert.ok(all && ait && gp);
  // 마켓통합은 (date) 소계에서 온다(합산이 아니라 distinct 재계산값).
  assert.equal(all.starts, 100);
  assert.equal(all.completes, 60);
  assert.equal(all.completionRatePct, 60); // 60/100
  assert.equal(all.avgSolveTimeSec, 100); // 6000/60
  assert.equal(all.players, 80); // 마켓별 55+25 와 다른 distinct 값

  assert.equal(ait.starts, 70);
  assert.equal(ait.completionRatePct, Math.round((40 / 70) * 1000) / 10);
  assert.equal(gp.avgSolveTimeSec, 120); // 2400/20
});

test("난이도 분해를 마켓통합/마켓개별 breakdowns 에 넣는다", () => {
  const rows: CrosswordGameRow[] = [
    row({ starts: 50, completes: 30 }),
    // 전체 난이도 분해 (date, difficulty)
    row({ difficulty: "easy", starts: 30, completes: 25, solveTimeSumSec: 1250 }),
    row({ difficulty: "hard", starts: 20, completes: 5, solveTimeSumSec: 500 }),
    // 마켓
    row({ market: "app-store", starts: 50, completes: 30 }),
    // 마켓 난이도 분해 (date, market, difficulty)
    row({ market: "app-store", difficulty: "easy", starts: 30, completes: 25 }),
  ];

  const records = assembleCrosswordDaily(rows);
  const all = records.find((r) => r.market === CROSSWORD_MARKET_ALL)!;
  const as = records.find((r) => r.market === "app-store")!;

  assert.deepEqual(Object.keys(all.breakdowns.byDifficulty).sort(), ["easy", "hard"]);
  assert.equal(all.breakdowns.byDifficulty.easy.completionRatePct, Math.round((25 / 30) * 1000) / 10);
  assert.equal(all.breakdowns.byDifficulty.easy.avgSolveTimeSec, 50); // 1250/25
  assert.equal(all.breakdowns.byDifficulty.hard.completes, 5);

  assert.deepEqual(Object.keys(as.breakdowns.byDifficulty), ["easy"]);
});

test("0 시작이면 완료율/평균시간은 null", () => {
  const records = assembleCrosswordDaily([row({ starts: 0, completes: 0 })]);
  const all = records[0];
  assert.equal(all.completionRatePct, null);
  assert.equal(all.avgSolveTimeSec, null);
});

test("여러 날짜를 날짜순으로 정렬해 반환한다", () => {
  const records = assembleCrosswordDaily([
    row({ date: "2026-07-11", starts: 1 }),
    row({ date: "2026-07-09", starts: 1 }),
    row({ date: "2026-07-10", starts: 1 }),
  ]);
  const dates = records.filter((r) => r.market === CROSSWORD_MARKET_ALL).map((r) => r.date);
  assert.deepEqual(dates, ["2026-07-09", "2026-07-10", "2026-07-11"]);
});
