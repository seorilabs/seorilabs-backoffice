import { prisma } from "@/lib/prisma";
import {
  dbDay,
  metricDayOf,
  metricDayWindow,
  metricDaysBetween,
  shiftMetricDay,
  toDbDay,
} from "@/lib/analytics/metric-day";
import {
  resolveAsOf,
  type AsOfResolution,
  type AsOfTarget,
  type CoverageCell,
} from "@/lib/analytics/as-of";
import {
  impliesLanded,
  isObserved,
  sealRule,
  type MetricObservationState,
  type MetricSource,
} from "@/lib/analytics/observation";
import { consoleCoverageTargets, ga4CoverageTargets } from "@/lib/analytics/targets";

// 수집 원장. (소스 × 대상 × 기준일) 칸을 관측했는지만 기록한다 — 지표 값의 정본은
// 여전히 AppMetricDaily/AppConsoleMetricDaily 다.
//
// 원장이 없던 동안 "행 없음"은 네 가지를 한꺼번에 뜻했다. 진짜 활동 0, export 미착지,
// 쿼리 실패, 애초에 수집 대상 아님. 그래서 합계의 분모가 날마다 흔들렸고 발행 수치가
// 실제의 1/3.6~1/6 로 나갔다. 그 넷을 가르는 것이 이 모듈의 전부다.

export interface ObservationInput {
  source: MetricSource;
  appId: string;
  /** 콘솔 miniAppId. 앱 단위 소스는 생략(0). */
  listingId?: number;
  day: string;
  state: MetricObservationState;
  detail?: string | null;
}

interface LedgerKeyParts {
  source: MetricSource;
  appId: string;
  listingId: number;
  day: string;
}

function ledgerKey(parts: LedgerKeyParts) {
  return {
    source_appId_listingId_day: {
      source: parts.source,
      appId: parts.appId,
      listingId: parts.listingId,
      day: toDbDay(parts.day),
    },
  };
}

const SEP = "\u0000";
const cellId = (parts: LedgerKeyParts) =>
  [parts.source, parts.appId, parts.listingId, parts.day].join(SEP);

/**
 * 원장 쓰기의 유일한 경계. 한 실행이 남기는 칸을 통째로 받아 이전 상태를 한 번에
 * 읽는다(칸마다 읽으면 창 14일 × 대상 9개에 쿼리가 두 배로 붙는다).
 *
 * 상태가 바뀌면 관측 횟수를 1 로 되돌린다 — seal 규칙이 "같은 상태로 N 회"를
 * 요구하므로, 상태가 흔들린 칸이 성숙한 것처럼 보이면 안 된다.
 */
export async function recordObservations(
  inputs: readonly ObservationInput[],
  now: Date,
): Promise<number> {
  if (inputs.length === 0) return 0;
  const parts = inputs.map((input) => ({
    ...input,
    listingId: input.listingId ?? 0,
  }));
  const previous = await prisma.metricCollectionLedger.findMany({
    where: {
      OR: parts.map((part) => ({
        source: part.source,
        appId: part.appId,
        listingId: part.listingId,
        day: toDbDay(part.day),
      })),
    },
    select: {
      source: true,
      appId: true,
      listingId: true,
      day: true,
      state: true,
      observations: true,
      landedAt: true,
    },
  });
  const byCell = new Map(
    previous.map((row) => [
      cellId({
        source: row.source as MetricSource,
        appId: row.appId,
        listingId: row.listingId,
        day: dbDay(row.day),
      }),
      row,
    ]),
  );

  const today = metricDayOf(now);
  let written = 0;
  for (const part of parts) {
    const prior = byCell.get(cellId(part));
    const observations = prior == null
      ? 1
      : prior.state === part.state
        ? prior.observations + 1
        : 1;
    const data = {
      state: part.state,
      sealed: sealRule({
        source: part.source,
        state: part.state,
        ageDays: metricDaysBetween(today, part.day),
        observations,
      }),
      detail: part.detail?.slice(0, 1_000) ?? null,
      landedAt: prior?.landedAt ?? (impliesLanded(part.state) ? now : null),
      observedAt: now,
      observations,
    };
    await prisma.metricCollectionLedger.upsert({
      where: ledgerKey(part),
      create: {
        source: part.source,
        appId: part.appId,
        listingId: part.listingId,
        day: toDbDay(part.day),
        ...data,
      },
      update: data,
    });
    written += 1;
  }
  return written;
}

export async function recordObservation(
  input: ObservationInput,
  now: Date,
): Promise<void> {
  await recordObservations([input], now);
}

/**
 * 수집 실패 기록. 이미 관측된 칸은 건드리지 않는다 — 일시적 오류가 이미 아는
 * 사실을 지우면, 다음 보고서가 멀쩡한 과거를 "미수집"으로 보고한다.
 */
export async function recordCollectionFailure(
  inputs: readonly Omit<ObservationInput, "state">[],
  now: Date,
): Promise<number> {
  if (inputs.length === 0) return 0;
  const parts = inputs.map((input) => ({ ...input, listingId: input.listingId ?? 0 }));
  const observed = await prisma.metricCollectionLedger.findMany({
    where: {
      OR: parts.map((part) => ({
        source: part.source,
        appId: part.appId,
        listingId: part.listingId,
        day: toDbDay(part.day),
      })),
      state: { in: ["observed", "empty"] },
    },
    select: { source: true, appId: true, listingId: true, day: true },
  });
  const keep = new Set(
    observed.map((row) =>
      cellId({
        source: row.source as MetricSource,
        appId: row.appId,
        listingId: row.listingId,
        day: dbDay(row.day),
      })
    ),
  );
  return recordObservations(
    parts.filter((part) => !keep.has(cellId(part))).map((part) => ({
      ...part,
      state: "failed" as const,
    })),
    now,
  );
}

/**
 * 착지 프로브 전용. 지표를 수집하지 않고 "소스 테이블이 생겼다"만 남긴다.
 * 이미 찍힌 landedAt 은 덮지 않는다 — 처음 본 시각이어야 발행 시각 판단에 쓸 수 있다.
 */
export async function recordLanding(input: {
  source: MetricSource;
  appId: string;
  listingId?: number;
  day: string;
  now: Date;
}): Promise<boolean> {
  const part = { ...input, listingId: input.listingId ?? 0 };
  const key = ledgerKey(part);
  const prior = await prisma.metricCollectionLedger.findUnique({
    where: key,
    select: { landedAt: true },
  });
  if (prior?.landedAt) return false;
  await prisma.metricCollectionLedger.upsert({
    where: key,
    create: {
      source: part.source,
      appId: part.appId,
      listingId: part.listingId,
      day: toDbDay(part.day),
      state: "not_landed",
      sealed: false,
      landedAt: input.now,
      observedAt: input.now,
      observations: 1,
    },
    update: { landedAt: input.now },
  });
  return true;
}

// ── 읽기: 기준일 해석과 날짜별 커버리지 ────────────────────────────────────

/**
 * 대상별 가중치(최근 관측값의 중앙값). 빠진 대상이 포트폴리오의 80% 인지 2% 인지를
 * 개수로는 알 수 없다 — 09-13 에 대상 3개 중 1개만 빠졌지만 무게로는 88% 였다.
 * 값이 없거나 0 인 대상도 분모에서 사라지지 않게 1 을 바닥으로 둔다.
 */
const WEIGHT_DAYS = 7;
const WEIGHT_FLOOR = 1;

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function ga4Weights(
  targets: readonly { appId: string; targetKey: string }[],
  from: string,
): Promise<AsOfTarget[]> {
  const rows = await prisma.appMetricDaily.findMany({
    where: { appId: { in: targets.map((t) => t.appId) }, date: { gte: toDbDay(from) } },
    select: { appId: true, dau: true },
  });
  const byApp = new Map<string, number[]>();
  for (const row of rows) {
    const list = byApp.get(row.appId) ?? [];
    list.push(row.dau);
    byApp.set(row.appId, list);
  }
  return targets.map((target) => ({
    targetKey: target.targetKey,
    weight: Math.max(WEIGHT_FLOOR, medianOf(byApp.get(target.appId) ?? [])),
  }));
}

async function consoleWeights(
  targets: readonly { appId: string; listingId: number; targetKey: string }[],
  from: string,
): Promise<AsOfTarget[]> {
  const rows = await prisma.appConsoleMetricDaily.findMany({
    where: { appId: { in: targets.map((t) => t.appId) }, date: { gte: toDbDay(from) } },
    select: { appId: true, miniAppId: true, iaaEarningKrw: true },
  });
  const byListing = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.appId}${SEP}${row.miniAppId}`;
    const list = byListing.get(key) ?? [];
    list.push(row.iaaEarningKrw);
    byListing.set(key, list);
  }
  return targets.map((target) => ({
    targetKey: target.targetKey,
    weight: Math.max(
      WEIGHT_FLOOR,
      medianOf(byListing.get(`${target.appId}${SEP}${target.listingId}`) ?? []),
    ),
  }));
}

async function cellsFor(
  source: MetricSource,
  targets: readonly { appId: string; listingId: number; targetKey: string }[],
  days: readonly string[],
): Promise<CoverageCell[]> {
  if (targets.length === 0 || days.length === 0) return [];
  const keyOf = new Map(
    targets.map((target) => [`${target.appId}${SEP}${target.listingId}`, target.targetKey]),
  );
  const rows = await prisma.metricCollectionLedger.findMany({
    where: {
      source,
      appId: { in: [...new Set(targets.map((t) => t.appId))] },
      day: { gte: toDbDay(days[0]), lte: toDbDay(days[days.length - 1]) },
    },
    select: { appId: true, listingId: true, day: true, state: true, sealed: true },
  });
  return rows.flatMap((row) => {
    const targetKey = keyOf.get(`${row.appId}${SEP}${row.listingId}`);
    if (!targetKey) return [];
    return [{
      targetKey,
      day: dbDay(row.day),
      state: row.state as MetricObservationState,
      sealed: row.sealed,
    }];
  });
}

export interface MetricAsOf {
  ga4: AsOfResolution | null;
  console: AsOfResolution | null;
}

/**
 * 소스별 기준일과 완결 판정. 콘솔은 자기 확정일을 따로 낸다 — GA4 기준일에 억지로
 * 맞추면 며칠 지난 값이 "어제 수치"로 둔갑한다.
 */
export async function metricAsOf(input: {
  now: Date;
  requested?: string | null;
  maxLookbackDays?: number;
}): Promise<MetricAsOf> {
  const today = metricDayOf(input.now);
  const lookback = Math.max(1, input.maxLookbackDays ?? 1);
  const days = metricDayWindow(shiftMetricDay(today, -1), lookback);
  const weightFrom = shiftMetricDay(today, -(lookback + WEIGHT_DAYS));

  const [ga4Targets, consoleTargets] = await Promise.all([
    ga4CoverageTargets(),
    consoleCoverageTargets(),
  ]);
  const [ga4Weighted, consoleWeighted, ga4Cells, consoleCells] = await Promise.all([
    ga4Weights(ga4Targets.targets, weightFrom),
    consoleWeights(consoleTargets.targets, weightFrom),
    cellsFor("ga4", ga4Targets.targets, days),
    cellsFor("ait_console", consoleTargets.targets, days),
  ]);

  const common = { today, requested: input.requested, maxLookbackDays: lookback };
  return {
    ga4: resolveAsOf({ ...common, targets: ga4Weighted, cells: ga4Cells }),
    console: resolveAsOf({ ...common, targets: consoleWeighted, cells: consoleCells }),
  };
}

export interface DayCoverage {
  observed: number;
  expected: number;
}

/**
 * 날짜별 관측/기대 수. 추이 그래프가 부분 관측일을 낮은 합계가 아니라 끊긴 선으로
 * 그리게 하는 입력이다. 한 앱이 빠진 날의 낮은 합계를 실제 감소로 읽던 것이
 * 화면에서 보이던 들쭉날쭉함의 정체였다.
 */
export async function ga4CoverageByDay(
  days: readonly string[],
): Promise<Map<string, DayCoverage>> {
  const { targets } = await ga4CoverageTargets();
  const cells = await cellsFor("ga4", targets, days);
  const byDay = new Map<string, DayCoverage>();
  for (const day of days) byDay.set(day, { observed: 0, expected: targets.length });
  for (const cell of cells) {
    const entry = byDay.get(cell.day);
    if (!entry) continue;
    if (cell.state === "not_applicable") entry.expected -= 1;
    else if (isObserved(cell.state)) entry.observed += 1;
  }
  return byDay;
}

export {
  METRIC_OBSERVATION_STATES,
  METRIC_SOURCES,
  SEAL_RULES,
  impliesLanded,
  isObserved,
  sealRule,
} from "@/lib/analytics/observation";
export type { MetricObservationState, MetricSource } from "@/lib/analytics/observation";
