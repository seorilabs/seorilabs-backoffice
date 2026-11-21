import type { Prisma } from "@prisma/client";
import { metricDayStart } from "@/lib/analytics/metric-day";
import { kstLogStamp } from "@/lib/format/kst";
import { notificationChannelId, type DestinationKey } from "@/lib/notifications/destinations";
import { prisma } from "@/lib/prisma";

// 날짜·앱 단위로 앱 이벤트를 쓰레드에 모으는 계약.
//
// 슬랙 채널에 건마다 메시지를 쌓으면 같은 앱의 하루가 한눈에 들어오지 않는다.
// 그날·그 앱의 첫 이벤트에 루트 메시지(본메시지) 하나를 만들고, 그 이벤트부터
// 쓰레드 댓글로 싣는다. 본메시지는 날짜·앱 이름·건수·마지막 갱신 시각만 들고,
// 이벤트 본문은 댓글에만 둔다.
//
// 쓰레드 루트는 Slack 메시지 ts 다. 그 ts 를 별도 표에 두지 않고 부모 알림의
// notification_delivery.providerMessageId 를 그대로 쓴다. 스키마를 넓히지 않고
// 이슈 알림 쓰레드(deliverIssueThread)와 같은 계약을 따른다.

/** 쓰레드로 묶는 목적지. 결제 알림은 건별 메시지를 유지한다. */
export const APP_EVENT_THREAD_DESTINATIONS = [
  "action-events",
  "ad-rewards",
] as const;

export type AppEventThreadDestination =
  (typeof APP_EVENT_THREAD_DESTINATIONS)[number];

/** 운영 이벤트를 목적지별로 나누는 묶음. */
export type OperationalEventGroup = "ad" | "iap" | "other";

export function operationalEventGroup(type: string): OperationalEventGroup {
  if (type.startsWith("iap.")) return "iap";
  if (type.startsWith("ad.")) return "ad";
  return "other";
}

/**
 * 묶음이 실제로 놓이는 목적지.
 *
 * 전용 채널이 아직 설정되지 않았으면 기존 폴백 규칙을 그대로 따른다. 설정이
 * 달라지면 폴백 대상 채널의 쓰레드에 그 이벤트가 합류한다.
 */
export function operationalGroupDestination(
  group: OperationalEventGroup,
): DestinationKey {
  if (group === "iap")
    return notificationChannelId("iap") ? "iap" : "action-events";
  if (group === "ad")
    return notificationChannelId("ad-rewards")
      ? "ad-rewards"
      : "action-events";
  return "action-events";
}

/** 이벤트가 실제로 놓이는 목적지. */
export function operationalDestinationKey(type: string): DestinationKey {
  return operationalGroupDestination(operationalEventGroup(type));
}

export function isAppEventThreadDestination(
  key: string,
): key is AppEventThreadDestination {
  return (APP_EVENT_THREAD_DESTINATIONS as readonly string[]).includes(key);
}

/** 쓰레드 단위 키. 목적지·KST 날짜·플랫폼 앱 id 로 하나다. */
export function appEventThreadKey(
  destinationKey: string,
  day: string,
  appId: string,
): string {
  return `operational-thread:${destinationKey}:${day}:${appId}`;
}

/** 본메시지(요약) 알림의 dedupeKey. */
export function appEventParentDedupeKey(
  destinationKey: string,
  day: string,
  appId: string,
): string {
  return appEventThreadKey(destinationKey, day, appId);
}

function inline(value: string): string {
  return value
    .replace(/[\r\n@<>]/g, "")
    .replace(/([\\`*_~|[\]])/g, "\\$1");
}

/** 본메시지 본문. 날짜·앱 이름·건수·마지막 갱신 시각. */
export function appEventThreadSummary(input: {
  destinationKey: string;
  day: string;
  appName: string;
  count: number;
  lastEventAt: Date | null;
  now?: Date;
}): string {
  const label = input.destinationKey === "ad-rewards" ? "광고보상" : "앱이벤트";
  const name = inline(input.appName).trim() || "알 수 없음";
  const stamp = input.lastEventAt
    ? kstLogStamp(input.lastEventAt, input.now ?? new Date())
    : "기록 없음";
  return `**[${name}]** ${input.day} ${label} ${input.count}건 · 마지막 업데이트 ${stamp}`;
}

/** 댓글 알림이 부모를 가리키는 계약. */
export interface AppEventThreadInfo {
  parentDedupeKey: string;
  destinationKey: string;
  day: string;
  appId: string;
}

/**
 * payload 에서 댓글 정보를 읽는다.
 *
 * 부모 payload 의 appEventThread 에는 parentDedupeKey 가 없다. 그 차이로
 * 본메시지와 댓글을 구분한다.
 */
export function appEventThreadPayload(
  payload: Prisma.JsonValue,
): AppEventThreadInfo | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const value = (payload as Prisma.JsonObject).appEventThread;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const thread = value as Prisma.JsonObject;
  const { parentDedupeKey, destinationKey, day, appId } = thread;
  if (
    typeof parentDedupeKey !== "string" ||
    !parentDedupeKey ||
    typeof destinationKey !== "string" ||
    !destinationKey ||
    typeof day !== "string" ||
    !day ||
    typeof appId !== "string" ||
    !appId
  )
    return null;
  return { parentDedupeKey, destinationKey, day, appId };
}

export type OperationalEventReader = Pick<
  Prisma.TransactionClient,
  "operationalEvent"
>;

export interface DayThreadStats {
  count: number;
  lastEventAt: Date | null;
}

/**
 * 그날 그 앱의 그 채널 이벤트 건수와 마지막 시각.
 *
 * 같은 목적지로 해석되는 이벤트만 센다. 전용 채널이 없으면 폴백 채널로
 * 해석되는 이벤트도 그 채널의 쓰레드에 함께 모이므로 같은 기준으로 센다.
 */
export async function dayThreadStats(input: {
  appId: string;
  day: string;
  destinationKey: string;
  db?: OperationalEventReader;
}): Promise<DayThreadStats> {
  const db = input.db ?? prisma;
  const start = metricDayStart(input.day);
  const end = new Date(start.getTime() + 86_400_000);
  const rows = await db.operationalEvent.findMany({
    where: { appId: input.appId, occurredAt: { gte: start, lt: end } },
    select: { eventType: true, occurredAt: true },
  });
  const destinations = new Map<OperationalEventGroup, DestinationKey>([
    ["ad", operationalGroupDestination("ad")],
    ["iap", operationalGroupDestination("iap")],
    ["other", operationalGroupDestination("other")],
  ]);
  let count = 0;
  let lastEventAt: Date | null = null;
  for (const row of rows) {
    if (
      destinations.get(operationalEventGroup(row.eventType)) !==
      input.destinationKey
    )
      continue;
    count += 1;
    if (!lastEventAt || row.occurredAt > lastEventAt)
      lastEventAt = row.occurredAt;
  }
  return { count, lastEventAt };
}
