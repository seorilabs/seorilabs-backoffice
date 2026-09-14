import { prisma } from "@/lib/prisma";
import { dbDay, metricDayOf, metricDaysBetween, toDbDay } from "@/lib/analytics/metric-day";

// 수집 원장. (소스 × 대상 × 기준일) 칸을 관측했는지만 기록한다 — 지표 값의 정본은
// 여전히 AppMetricDaily/AppConsoleMetricDaily 다.
//
// 원장이 없던 동안 "행 없음"은 네 가지를 한꺼번에 뜻했다. 진짜 활동 0, export 미착지,
// 쿼리 실패, 애초에 수집 대상 아님. 그래서 합계의 분모가 날마다 흔들렸고 발행 수치가
// 실제의 1/3.6~1/6 로 나갔다. 그 넷을 가르는 것이 이 모듈의 전부다.

export const METRIC_SOURCES = ["ga4", "ait_console"] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

export const METRIC_OBSERVATION_STATES = [
  "observed", // 소스가 그 날을 응답했고 값을 저장했다.
  "empty", // 소스 테이블은 착지했는데 그 대상의 그 날 활동이 진짜 0 이다.
  "not_landed", // export/푸시가 아직 없다. 나중에 채워질 수 있다.
  "failed", // 쿼리·푸시가 오류로 끝났다. 재시도 대상.
  "not_applicable", // 그 날 이 대상은 수집 범위가 아니다(출시 전·중단·매핑 없음).
] as const;
export type MetricObservationState = (typeof METRIC_OBSERVATION_STATES)[number];

/** 이 칸이 합산 분모를 채웠는가. 값을 본 것과 0 임을 본 것만 "관측됨"이다. */
export function isObserved(state: MetricObservationState): boolean {
  return state === "observed" || state === "empty";
}

/** 소스 테이블이 존재한다는 뜻인가. landedAt 을 찍을 조건이다. */
export function impliesLanded(state: MetricObservationState): boolean {
  return isObserved(state);
}

/**
 * GA4 는 같은 상태로 두 번 이상 봐야 봉인한다. 한 번 관측만으로 봉인하면 첫 관측이
 * 미완결 테이블이었을 때 낮은 값이 영구 고정된다(09-12 에 실제로 그럴 뻔했다).
 * 콘솔은 자동 수집이 없어 관측 횟수로 성숙을 말할 수 없으므로 경과일만 본다.
 */
export const SEAL_RULES: Record<
  MetricSource,
  { minAgeDays: number; minObservations: number }
> = {
  ga4: { minAgeDays: 2, minObservations: 2 },
  ait_console: { minAgeDays: 3, minObservations: 1 },
};

/**
 * 이 칸이 다시는 바뀌지 않는가(순수). failed·not_landed 는 절대 봉인되지 않는다 —
 * 영구히 실패한 대상이 있으면 그 날은 영원히 잠정이고, 그것이 정확한 표현이다.
 */
export function sealRule(input: {
  source: MetricSource;
  state: MetricObservationState;
  ageDays: number;
  observations: number;
}): boolean {
  if (!isObserved(input.state)) return false;
  // 콘솔은 push 로만 들어와 "활동 0"을 관측할 수 없다. empty 는 GA4 전용이다.
  if (input.source === "ait_console" && input.state !== "observed") return false;
  const rule = SEAL_RULES[input.source];
  return input.ageDays >= rule.minAgeDays && input.observations >= rule.minObservations;
}

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

const cellId = (parts: LedgerKeyParts) =>
  `${parts.source}\u0000${parts.appId}\u0000${parts.listingId}\u0000${parts.day}`;

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
