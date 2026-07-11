import { prisma } from "@/lib/prisma";
import { parseIsoDate, type Ga4Target } from "@/lib/ga4/datasets";
import {
  queryCrosswordGameMetrics,
  type CrosswordGameRow,
} from "@/lib/ga4/crossword-game";
import type { Prisma } from "@prisma/client";

// 가로세로 낱말 퍼즐 게임 세부 지표 수집(crossword 전용, 격리 파일).
// GROUPING SETS 조회 결과(날짜×마켓×난이도 소계 포함)를 저장용 레코드(날짜×마켓)로
// 조립하고 CrosswordMetricDaily 로 멱등 upsert 한다. 마켓통합은 market='all' 로 저장한다.

/** 마켓통합 저장 키. 마켓개별 값은 core MarketTarget 과 동일하다. */
export const CROSSWORD_MARKET_ALL = "all";

export interface CrosswordDifficultyMetrics {
  starts: number;
  completes: number;
  abandons: number;
  completionRatePct: number | null;
  avgSolveTimeSec: number | null;
  hintUses: number;
  revealUses: number;
  players: number;
}

export interface CrosswordBreakdowns {
  /** 난이도(easy/normal/hard)별 세부 지표. */
  byDifficulty: Record<string, CrosswordDifficultyMetrics>;
}

/** CrosswordMetricDaily 한 행(= 날짜×마켓)의 저장 값. */
export interface CrosswordDailyRecord {
  date: string; // "YYYY-MM-DD"
  market: string; // 'all' | 'apps-in-toss' | 'google-play' | 'app-store'
  starts: number;
  firstInputs: number;
  progressReaches: number;
  completes: number;
  abandons: number;
  completionRatePct: number | null;
  avgSolveTimeSec: number | null;
  noHintCompletes: number;
  firstTryCompletes: number;
  hintUses: number;
  revealUses: number;
  stuckHintUses: number;
  assistAdRequests: number;
  assistAdRewards: number;
  players: number;
  completePlayers: number;
  breakdowns: CrosswordBreakdowns;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function completionRatePct(completes: number, starts: number): number | null {
  return starts > 0 ? round1((completes / starts) * 100) : null;
}

function avgSolveTimeSec(sumSec: number, completes: number): number | null {
  return completes > 0 ? round1(sumSec / completes) : null;
}

function difficultyMetrics(row: CrosswordGameRow): CrosswordDifficultyMetrics {
  return {
    starts: row.starts,
    completes: row.completes,
    abandons: row.abandons,
    completionRatePct: completionRatePct(row.completes, row.starts),
    avgSolveTimeSec: avgSolveTimeSec(row.solveTimeSumSec, row.completes),
    hintUses: row.hintUses,
    revealUses: row.revealUses,
    players: row.players,
  };
}

function baseRecord(
  date: string,
  market: string,
  total: CrosswordGameRow | undefined,
  diffRows: CrosswordGameRow[],
): CrosswordDailyRecord {
  const t = total;
  const byDifficulty: Record<string, CrosswordDifficultyMetrics> = {};
  for (const d of diffRows) {
    if (d.difficulty) byDifficulty[d.difficulty] = difficultyMetrics(d);
  }
  return {
    date,
    market,
    starts: t?.starts ?? 0,
    firstInputs: t?.firstInputs ?? 0,
    progressReaches: t?.progressReaches ?? 0,
    completes: t?.completes ?? 0,
    abandons: t?.abandons ?? 0,
    completionRatePct: completionRatePct(t?.completes ?? 0, t?.starts ?? 0),
    avgSolveTimeSec: avgSolveTimeSec(t?.solveTimeSumSec ?? 0, t?.completes ?? 0),
    noHintCompletes: t?.noHintCompletes ?? 0,
    firstTryCompletes: t?.firstTryCompletes ?? 0,
    hintUses: t?.hintUses ?? 0,
    revealUses: t?.revealUses ?? 0,
    stuckHintUses: t?.stuckHintUses ?? 0,
    assistAdRequests: t?.assistAdRequests ?? 0,
    assistAdRewards: t?.assistAdRewards ?? 0,
    players: t?.players ?? 0,
    completePlayers: t?.completePlayers ?? 0,
    breakdowns: { byDifficulty },
  };
}

/**
 * GROUPING SETS 행들을 저장용 레코드(날짜×마켓, 마켓통합 'all' 포함)로 조립하는 순수 함수.
 * - market≠null,difficulty=null → 마켓 소계(마켓 행의 컬럼)
 * - market=null,difficulty=null → 전체 소계(all 행의 컬럼)
 * - market≠null,difficulty≠null → 마켓별 난이도 분해
 * - market=null,difficulty≠null → 전체 난이도 분해
 */
export function assembleCrosswordDaily(
  rows: CrosswordGameRow[],
): CrosswordDailyRecord[] {
  // date → 분류된 행들.
  type Bucket = {
    allTotal?: CrosswordGameRow;
    allDiff: CrosswordGameRow[];
    marketTotal: Map<string, CrosswordGameRow>;
    marketDiff: Map<string, CrosswordGameRow[]>;
  };
  const byDate = new Map<string, Bucket>();

  for (const row of rows) {
    const bucket =
      byDate.get(row.date) ??
      byDate
        .set(row.date, {
          allDiff: [],
          marketTotal: new Map(),
          marketDiff: new Map(),
        })
        .get(row.date)!;

    const hasMarket = row.market != null;
    const hasDiff = row.difficulty != null;
    if (!hasMarket && !hasDiff) {
      bucket.allTotal = row;
    } else if (!hasMarket && hasDiff) {
      bucket.allDiff.push(row);
    } else if (hasMarket && !hasDiff) {
      bucket.marketTotal.set(row.market as string, row);
    } else {
      const key = row.market as string;
      (bucket.marketDiff.get(key) ?? bucket.marketDiff.set(key, []).get(key)!).push(row);
    }
  }

  const out: CrosswordDailyRecord[] = [];
  const dates = [...byDate.keys()].sort();
  for (const date of dates) {
    const b = byDate.get(date)!;
    // 마켓통합.
    out.push(baseRecord(date, CROSSWORD_MARKET_ALL, b.allTotal, b.allDiff));
    // 마켓개별(존재하는 마켓만).
    const markets = [...b.marketTotal.keys()].sort();
    for (const market of markets) {
      out.push(
        baseRecord(
          date,
          market,
          b.marketTotal.get(market),
          b.marketDiff.get(market) ?? [],
        ),
      );
    }
  }
  return out;
}

/**
 * 게임 세부 지표 수집 + 저장(멱등). collectMetrics 의 앱 루프에서 crossword-puzzle 앱에만
 * 호출된다. 저장 실패/조회 실패는 호출부에서 앱 단위로 격리 처리한다.
 * @returns upsert 한 (날짜×마켓) row 수.
 */
export async function collectCrosswordGameMetrics(params: {
  appId: string;
  target: Ga4Target;
  startSuffix: string;
  endSuffix: string;
  now: Date;
}): Promise<number> {
  const rows = await queryCrosswordGameMetrics(
    params.target,
    params.startSuffix,
    params.endSuffix,
  );
  const records = assembleCrosswordDaily(rows);
  let upserts = 0;
  for (const rec of records) {
    const date = parseIsoDate(rec.date);
    const { date: _date, market, breakdowns, ...columns } = rec;
    void _date;
    const data = {
      ...columns,
      breakdowns: breakdowns as unknown as Prisma.InputJsonValue,
      collectedAt: params.now,
    };
    await prisma.crosswordMetricDaily.upsert({
      where: {
        appId_date_market: { appId: params.appId, date, market },
      },
      create: { appId: params.appId, date, market, ...data },
      update: data,
    });
    upserts++;
  }
  return upserts;
}
