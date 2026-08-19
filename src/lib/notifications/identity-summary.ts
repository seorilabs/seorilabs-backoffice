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

export interface IdentitySignupFacts {
  displayName: string;
  dateKey: string;
  todayTotal: number;
  cumulative: number | null;
  latestAt: Date;
  previousAt: Date | null;
  anonymous: number;
  authTypes: Array<[string, number]>;
  referrers: Array<[string, number]>;
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
  const authTypes = new Map<string, number>();
  const referrers = new Map<string, number>();
  let anonymous = 0;
  for (const row of input.rows) {
    if (
      row.attributes &&
      typeof row.attributes === "object" &&
      !Array.isArray(row.attributes) &&
      (row.attributes as Prisma.JsonObject).anonymous === true
    ) {
      anonymous++;
    }
    const authType = attributeText(row.attributes, "authType");
    if (authType) authTypes.set(authType, (authTypes.get(authType) ?? 0) + 1);
    const referrer = attributeText(row.attributes, "referrer");
    if (referrer) referrers.set(referrer, (referrers.get(referrer) ?? 0) + 1);
  }
  return {
    displayName: input.displayName,
    dateKey: input.dateKey,
    todayTotal: input.todayTotal,
    cumulative: input.cumulative,
    latestAt: latest.occurredAt,
    previousAt: previous?.occurredAt ?? null,
    anonymous,
    authTypes: tally(authTypes),
    referrers: tally(referrers),
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
  if (facts.authTypes.length) {
    lines.push(`인증: ${facts.authTypes.map(([key, count]) => `${key} ${count}`).join(" · ")}`);
  }
  if (facts.anonymous) lines.push(`익명 계정: ${facts.anonymous}`);
  if (facts.referrers.length) {
    lines.push(`유입: ${facts.referrers.map(([key, count]) => `${key} ${count}`).join(" · ")}`);
  }
  return lines.join("\n");
}

export function identitySummaryDedupeKey(appSlug: string, dateKey: string): string {
  return `identity-daily:${appSlug}:${dateKey}`;
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
  return true;
}
