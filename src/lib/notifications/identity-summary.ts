import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { kstDayStart } from "@/lib/core/operations-report";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification, requeueNotification } from "@/lib/notifications/outbox";
import type { OperationalEventInput } from "@/lib/platform/operational-events";

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
// 분해 표시용 표본 상한. 총계는 count로 따로 세므로 상한을 넘겨도 숫자는 정확하다.
const BREAKDOWN_SAMPLE = 1_000;

export interface IdentityEventRow {
  occurredAt: Date;
  attributes: Prisma.JsonValue;
}

// 카드에 분해로 보여 줄 속성과 라벨. 선언 순서가 그대로 카드 줄 순서다.
//
// authType은 계정이 만들어진 인증 경로라 firebase_bridge 하나로 뭉친다. 실제 로그인
// 수단과 어느 빌드에서 들어왔는지는 다른 축이라 따로 센다.
const BREAKDOWN_LABELS = {
  authType: "인증",
  signInProvider: "로그인",
  appVersion: "버전",
  runtime: "런타임",
  referrer: "유입",
} as const;

export type BreakdownAttribute = keyof typeof BREAKDOWN_LABELS;

const BREAKDOWN_ATTRIBUTES = Object.keys(BREAKDOWN_LABELS) as BreakdownAttribute[];

export type IdentityBreakdowns = Record<BreakdownAttribute, Array<[string, number]>>;

export interface IdentitySignupFacts {
  displayName: string;
  dateKey: string;
  todayTotal: number;
  cumulative: number | null;
  latestAt: Date;
  previousAt: Date | null;
  anonymous: number;
  breakdowns: IdentityBreakdowns;
}

export function kstDateKey(date: Date): string {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
}

function attributeText(attributes: Prisma.JsonValue, key: string): string | null {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return null;
  const value = (attributes as Prisma.JsonObject)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function attributeFlag(attributes: Prisma.JsonValue, key: string): boolean {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  return (attributes as Prisma.JsonObject)[key] === true;
}

function tally(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function summarizeIdentityEvents(input: {
  displayName: string;
  dateKey: string;
  todayTotal: number;
  cumulative: number | null;
  rows: IdentityEventRow[];
}): IdentitySignupFacts | null {
  // 최신순으로 들어온 당일 이벤트다. 하나도 없으면 알릴 내용이 없다.
  const [latest, previous] = input.rows;
  if (!latest) return null;
  const counts = Object.fromEntries(
    BREAKDOWN_ATTRIBUTES.map((key) => [key, new Map<string, number>()]),
  ) as Record<BreakdownAttribute, Map<string, number>>;
  let anonymous = 0;
  for (const row of input.rows) {
    if (attributeFlag(row.attributes, "anonymous")) anonymous++;
    for (const key of BREAKDOWN_ATTRIBUTES) {
      // 값이 없는 축은 세지 않는다. 분해 합이 신규 수보다 작은 게 정상이다.
      const value = attributeText(row.attributes, key);
      if (!value) continue;
      const bucket = counts[key];
      bucket.set(value, (bucket.get(value) ?? 0) + 1);
    }
  }
  return {
    displayName: input.displayName,
    dateKey: input.dateKey,
    todayTotal: input.todayTotal,
    cumulative: input.cumulative,
    latestAt: latest.occurredAt,
    previousAt: previous?.occurredAt ?? null,
    anonymous,
    breakdowns: Object.fromEntries(
      BREAKDOWN_ATTRIBUTES.map((key) => [key, tally(counts[key])]),
    ) as IdentityBreakdowns,
  };
}

export function identitySummaryText(facts: IdentitySignupFacts): string {
  const time = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(facts.latestAt);
  const lines = [`👤 **${facts.displayName} · 오늘 신규 계정 ${facts.todayTotal}명**`];
  const gap = facts.previousAt
    ? ` · 직전 간격 ${formatElapsed(facts.latestAt.getTime() - facts.previousAt.getTime())}`
    : "";
  lines.push(`최근 생성: ${time}${gap}`);
  if (facts.cumulative !== null) lines.push(`누적: ${facts.cumulative}번째 계정`);
  for (const key of BREAKDOWN_ATTRIBUTES) {
    const entries = facts.breakdowns[key];
    if (!entries.length) continue;
    const body = entries.map(([value, count]) => `${value} ${count}`).join(" · ");
    lines.push(`${BREAKDOWN_LABELS[key]}: ${body}`);
  }
  if (facts.anonymous) lines.push(`익명 계정: ${facts.anonymous}`);
  return lines.join("\n");
}

export function identitySummaryDedupeKey(appSlug: string, dateKey: string): string {
  return `identity-daily:${appSlug}:${dateKey}`;
}

export function identityRowDedupeKey(eventId: string): string {
  return `identity-row:${eventId}`;
}

export function identityThreadName(displayName: string, dateKey: string): string {
  return `${displayName} 신규 계정 ${dateKey}`;
}

/**
 * 건별 행이 볼 당일 범위. 순번은 이 이벤트까지 포함해 세고(`lte`), 직전 계정은 이
 * 이벤트를 빼고 찾는다(`lt`).
 *
 * 당일 전체(`lt: dayEnd`)로 세면 안 된다. Platform 재전송으로 옛 이벤트가 다시
 * 들어왔을 때 그 뒤에 생긴 계정까지 세어 순번과 간격이 그 이벤트의 사실이 아니게 된다.
 */
export function identityRowRanges(dayStart: Date, occurredAt: Date) {
  return {
    upTo: { gte: dayStart, lte: occurredAt },
    before: { gte: dayStart, lt: occurredAt },
  };
}

export interface IdentityRowFacts {
  ordinal: number;
  occurredAt: Date;
  previousAt: Date | null;
  authType: string | null;
  signInProvider: string | null;
  appVersion: string | null;
  runtime: string | null;
  anonymous: boolean;
  referrer: string | null;
}

// 요약 카드가 가리는 건별 사실만 담는다. 가입이 몰리는 시간대와 간격이 읽히도록
// 시각과 직전 간격을 앞에 두고, 인증·유입은 있을 때만 붙인다.
export function identityRowText(facts: IdentityRowFacts): string {
  const time = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(facts.occurredAt);
  const parts = [`\`#${facts.ordinal}\``, time];
  if (facts.previousAt) {
    parts.push(`직전 +${formatElapsed(facts.occurredAt.getTime() - facts.previousAt.getTime())}`);
  }
  if (facts.authType) parts.push(facts.authType);
  if (facts.signInProvider) parts.push(facts.signInProvider);
  // 버전만 접두사를 붙인다. 숫자만 있으면 앞뒤 값과 구분되지 않는다.
  if (facts.appVersion) parts.push(`v${facts.appVersion}`);
  if (facts.runtime) parts.push(facts.runtime);
  if (facts.anonymous) parts.push("익명");
  if (facts.referrer) parts.push(`유입 ${facts.referrer}`);
  return parts.join(" · ");
}

// 신규 계정은 건별 카드 대신 앱·일 단위 카드 하나를 갱신한다. 같은 채널에서
// 유입 속도와 누적을 한 장으로 읽을 수 있고, 계정마다 알림이 쌓이지 않는다.
export async function recordIdentitySignup(input: {
  app: { slug: string; displayName: string; platformUserBaseline: number | null };
  event: OperationalEventInput;
}): Promise<boolean> {
  const occurredAt = new Date(input.event.occurredAt);
  const dayStart = kstDayStart(occurredAt);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const where = {
    appId: input.app.slug,
    eventType: "identity.created",
    occurredAt: { gte: dayStart, lt: dayEnd },
  } as const;
  const [todayTotal, observedTotal, rows] = await Promise.all([
    prisma.operationalEvent.count({ where }),
    prisma.operationalEvent.count({
      where: { appId: input.app.slug, eventType: "identity.created" },
    }),
    prisma.operationalEvent.findMany({
      where,
      select: { occurredAt: true, attributes: true },
      orderBy: { occurredAt: "desc" },
      take: BREAKDOWN_SAMPLE,
    }),
  ]);
  const facts = summarizeIdentityEvents({
    displayName: input.app.displayName,
    dateKey: kstDateKey(occurredAt),
    todayTotal,
    cumulative:
      input.app.platformUserBaseline === null
        ? null
        : input.app.platformUserBaseline + observedTotal,
    rows,
  });
  if (!facts) return false;
  const eventId = await enqueueNotification({
    dedupeKey: identitySummaryDedupeKey(input.app.slug, facts.dateKey),
    kind: "IDENTITY_SUMMARY",
    occurredAt: facts.latestAt,
    payload: { text: identitySummaryText(facts) },
    destinations: discordDestinations(["action-events"]),
  });
  await requeueNotification(eventId);

  // 카드가 가린 건별 사실은 카드 쓰레드에 댓글로 남긴다. 카드 delivery가 먼저
  // 만들어졌으므로 createdAt 순으로 도는 outbox가 카드를 먼저 보내고, 댓글은 그때
  // 확정된 카드 메시지에 쓰레드를 건다.
  const ranges = identityRowRanges(dayStart, occurredAt);
  const [ordinal, previous] = await Promise.all([
    prisma.operationalEvent.count({ where: { ...where, occurredAt: ranges.upTo } }),
    prisma.operationalEvent.findFirst({
      where: { ...where, occurredAt: ranges.before },
      select: { occurredAt: true },
      orderBy: { occurredAt: "desc" },
    }),
  ]);
  await enqueueNotification({
    dedupeKey: identityRowDedupeKey(input.event.eventId),
    kind: "IDENTITY_ROW",
    occurredAt,
    payload: {
      text: identityRowText({
        ordinal,
        occurredAt,
        previousAt: previous?.occurredAt ?? null,
        authType: attributeText(input.event.attributes, "authType"),
        signInProvider: attributeText(input.event.attributes, "signInProvider"),
        appVersion: attributeText(input.event.attributes, "appVersion"),
        runtime: attributeText(input.event.attributes, "runtime"),
        anonymous: attributeFlag(input.event.attributes, "anonymous"),
        referrer: attributeText(input.event.attributes, "referrer"),
      }),
      cardDedupeKey: identitySummaryDedupeKey(input.app.slug, facts.dateKey),
      threadName: identityThreadName(input.app.displayName, facts.dateKey),
      // 하루 첫 댓글만 멘션한다. 멘션되면 쓰레드 멤버로 추가돼 이후 댓글도 알림이 간다.
      first: ordinal === 1,
    },
    destinations: discordDestinations(["action-events"]),
  });
  return true;
}
