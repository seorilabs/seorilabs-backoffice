import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { metricDayOf, metricDayStart } from "@/lib/analytics/metric-day";
import { kstLogStamp } from "@/lib/format/kst";
import { dailyRowRanges, formatElapsed } from "@/lib/notifications/daily-rows";
import {
  discordDestinationOrFallback,
  type NotificationDestination,
} from "@/lib/notifications/destinations";
import { renderPayload, type DiscordRender } from "@/lib/notifications/format";
import { enqueueNotification, requeueNotification } from "@/lib/notifications/outbox";
import { EMBED_COLOR } from "@/lib/notifications/style";
import { resolvedPlatformAppId } from "@/lib/platform/app-id";
import type { OperationalEventInput } from "@/lib/platform/operational-events";

const DAY_MS = 24 * 60 * 60 * 1_000;
// 건별 행 표본 상한. 총계는 count 로 따로 세므로 넘겨도 숫자는 정확하다.
const ROW_SAMPLE = 1_000;

export const IAP_MARKET_LABELS: Record<string, string> = {
  app_store: "App Store",
  google_play: "Google Play",
  apps_in_toss: "앱인토스",
  operator: "운영자 지급",
};

export function marketLabel(value: unknown): string {
  const key = typeof value === "string" ? value : "";
  return IAP_MARKET_LABELS[key] ?? (key || "unknown");
}

/**
 * 테스트 주문 여부의 3상태.
 *
 * 키가 없거나 null 이면 "미확인" 이다. 없는 사실을 실거래로 접으면 앱인토스 주문이
 * 전부 실거래로 보인다 — provider 가 이 값을 만들지 않기 때문이다(platform
 * providers/toss). Apple 은 sandbox 환경, Google Play 는 testPurchaseContext 로 판정한다.
 */
export type TestPurchaseState = "test" | "real" | "unknown";

export function testPurchaseState(attributes: Prisma.JsonValue): TestPurchaseState {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return "unknown";
  const value = (attributes as Prisma.JsonObject).isTestPurchase;
  if (value === true) return "test";
  if (value === false) return "real";
  return "unknown";
}

/**
 * 상품 권리를 접두사로 묶는다. `sp_moonlight_crested` → `sp_*`.
 *
 * 하루 결제가 여러 건이면 개별 ID 를 늘어놓는 것보다 종류 분포가 먼저 읽힌다.
 * 접두사 규약이 없는 앱(언더스코어 없음)은 ID 를 그대로 쓴다.
 */
export function entitlementGroup(entitlementId: string): string {
  const index = entitlementId.indexOf("_");
  return index > 0 ? `${entitlementId.slice(0, index)}_*` : entitlementId;
}

function attributeText(attributes: Prisma.JsonValue, key: string): string | null {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return null;
  const value = (attributes as Prisma.JsonObject)[key];
  return typeof value === "string" && value ? value : null;
}

function tally(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface IapGrantRow {
  occurredAt: Date;
  attributes: Prisma.JsonValue;
}

export interface IapSummaryFacts {
  displayName: string;
  dateKey: string;
  todayTotal: number;
  latestAt: Date;
  previousAt: Date | null;
  markets: Array<[string, number]>;
  products: Array<[string, number]>;
  testCount: number;
  unknownCount: number;
}

export function summarizeIapGrants(input: {
  displayName: string;
  dateKey: string;
  todayTotal: number;
  rows: IapGrantRow[];
}): IapSummaryFacts | null {
  const [latest, previous] = input.rows;
  if (!latest || input.todayTotal === 0) return null;
  const states = input.rows.map((row) => testPurchaseState(row.attributes));
  return {
    displayName: input.displayName,
    dateKey: input.dateKey,
    todayTotal: input.todayTotal,
    latestAt: latest.occurredAt,
    previousAt: previous?.occurredAt ?? null,
    markets: tally(input.rows.map((row) => marketLabel(attributeText(row.attributes, "platform")))),
    products: tally(
      input.rows.map((row) => entitlementGroup(attributeText(row.attributes, "entitlementId") ?? "unknown")),
    ),
    testCount: states.filter((state) => state === "test").length,
    unknownCount: states.filter((state) => state === "unknown").length,
  };
}

/**
 * 앱·일 결제 요약 카드.
 *
 * 누적 줄을 넣지 않는다. 신규 계정은 platformUserBaseline 이 있어 앱 생애 누적을
 * 정직하게 낼 수 있지만 IAP 에는 대응 baseline 이 없다. operational_event 전체
 * 카운트는 "이벤트 수신 시작 이후" 라서 누적처럼 보이지만 아니다.
 */
export function iapSummaryRender(facts: IapSummaryFacts): DiscordRender {
  const head = [`최근 ${kstLogStamp(facts.latestAt, facts.latestAt)}`];
  if (facts.previousAt) {
    head.push(`직전 간격 ${formatElapsed(facts.latestAt.getTime() - facts.previousAt.getTime())}`);
  }
  const lines = [
    head.join(" · "),
    `마켓 ${facts.markets.map(([label, n]) => `${label} ${n}`).join(" · ")}`,
    `상품 ${facts.products.map(([group, n]) => `${group} ${n}`).join(" · ")}`,
  ];
  // 실거래에는 표식을 붙이지 않는다. 대다수라 표식이 신호가 아니라 배경이 된다.
  // 반대로 미확인은 반드시 드러낸다 — 앱인토스를 우리가 판정하지 못한다는 사실이
  // 보이는 유일한 지점이고, provider 가 값을 주기 시작하면 이 줄이 저절로 사라진다.
  const flags: string[] = [];
  if (facts.testCount) flags.push(`테스트 주문 ${facts.testCount}건`);
  if (facts.unknownCount) flags.push(`미확인 ${facts.unknownCount}건`);
  if (flags.length) lines.push(flags.join(" · "));
  return {
    text: lines.join("\n"),
    embed: {
      title: `💳 ${facts.displayName} · 결제 ${facts.todayTotal}건`,
      color: EMBED_COLOR.NEUTRAL,
      footer: `${facts.dateKey} KST`,
      timestamp: facts.latestAt.toISOString(),
    },
  };
}

export interface IapRowFacts {
  ordinal: number;
  occurredAt: Date;
  previousAt: Date | null;
  market: string;
  entitlementId: string | null;
  test: TestPurchaseState;
}

export function iapRowText(facts: IapRowFacts): string {
  const parts = [
    `\`#${facts.ordinal}\``,
    kstLogStamp(facts.occurredAt, facts.occurredAt),
  ];
  if (facts.previousAt) {
    parts.push(`직전 +${formatElapsed(facts.occurredAt.getTime() - facts.previousAt.getTime())}`);
  }
  parts.push(facts.market, facts.entitlementId ?? "unknown");
  if (facts.test === "test") parts.push("🧪테스트");
  if (facts.test === "unknown") parts.push("❔미확인");
  return parts.join(" · ");
}

/**
 * 카드 dedupe 키에 목적지를 넣는다.
 *
 * enqueueNotification 의 update 는 payload 만 갱신하고 delivery 를 추가하지 않는다.
 * 채널 ID 를 하루 중간에 봉인하면, 봉인 전 카드는 폴백 채널 delivery 하나만 가진
 * 채 계속 편집되고 건별 행만 새 채널로 간다. 그러면 행이 부모 카드를 영영 못 찾아
 * 재시도 끝에 dead letter 가 된다. 목적지가 키에 있으면 채널이 바뀐 날은 새 카드가
 * 만들어지고 쓰레드도 거기 붙는다.
 */
export function iapSummaryDedupeKey(
  destinationKey: string,
  appSlug: string,
  dateKey: string,
): string {
  return `iap-daily:${destinationKey}:${appSlug}:${dateKey}`;
}

export function iapRowDedupeKey(eventId: string): string {
  return `iap-row:${eventId}`;
}

export function iapThreadName(displayName: string, dateKey: string): string {
  return `${displayName} 결제 ${dateKey}`;
}

/** 결제 확정 한 건을 앱·일 요약 카드와 그 쓰레드 행으로 기록한다. */
export async function recordIapGrant(input: {
  app: { slug: string; platformAppId: string | null; displayName: string };
  event: OperationalEventInput;
}): Promise<boolean> {
  const occurredAt = new Date(input.event.occurredAt);
  const dayStart = metricDayStart(metricDayOf(occurredAt));
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const eventAppId = resolvedPlatformAppId(input.app);
  const where = {
    appId: eventAppId,
    eventType: "iap.granted",
    occurredAt: { gte: dayStart, lt: dayEnd },
  } as const;
  const [todayTotal, rows] = await Promise.all([
    prisma.operationalEvent.count({ where }),
    prisma.operationalEvent.findMany({
      where,
      select: { occurredAt: true, attributes: true },
      orderBy: { occurredAt: "desc" },
      take: ROW_SAMPLE,
    }),
  ]);
  const facts = summarizeIapGrants({
    displayName: input.app.displayName,
    dateKey: metricDayOf(occurredAt),
    todayTotal,
    rows,
  });
  if (!facts) return false;

  // 목적지를 한 번만 정해 dedupe 키와 delivery 양쪽에 같은 값을 쓴다.
  const [destination] = iapDestinations();
  const cardDedupeKey = iapSummaryDedupeKey(destination.key, input.app.slug, facts.dateKey);
  const eventId = await enqueueNotification({
    dedupeKey: cardDedupeKey,
    kind: "OPERATIONAL_EVENT",
    occurredAt: facts.latestAt,
    // 같은 카드를 계속 갱신한다. 건마다 새 카드를 보내면 채널이 다시 카드 더미가 된다.
    payload: renderPayload(iapSummaryRender(facts), { editable: true }),
    destinations: [destination],
  });
  await requeueNotification(eventId);

  // 카드가 가린 건별 사실은 카드 쓰레드에 남긴다. 카드 delivery 가 먼저 만들어졌으므로
  // createdAt 순으로 도는 outbox 가 카드를 먼저 보내고, 행은 그때 확정된 메시지에 붙는다.
  const eventAttributes = input.event.attributes as Prisma.JsonValue;
  const ranges = dailyRowRanges(dayStart, occurredAt);
  const [ordinal, previous] = await Promise.all([
    prisma.operationalEvent.count({ where: { ...where, occurredAt: ranges.upTo } }),
    prisma.operationalEvent.findFirst({
      where: { ...where, occurredAt: ranges.before },
      select: { occurredAt: true },
      orderBy: { occurredAt: "desc" },
    }),
  ]);
  await enqueueNotification({
    dedupeKey: iapRowDedupeKey(input.event.eventId),
    kind: "OPERATIONAL_EVENT",
    occurredAt,
    payload: {
      text: iapRowText({
        ordinal,
        occurredAt,
        previousAt: previous?.occurredAt ?? null,
        market: marketLabel(attributeText(eventAttributes, "platform")),
        entitlementId: attributeText(eventAttributes, "entitlementId"),
        test: testPurchaseState(eventAttributes),
      }),
      // 쓰레드 게시는 kind 가 아니라 payload 로 구분한다. NotificationKind 는 MySQL
      // ENUM 이라 값 추가에 ALTER MODIFY 가 필요한데 expand-only 게이트가 막는다.
      thread: {
        parentDedupeKey: cardDedupeKey,
        threadName: iapThreadName(input.app.displayName, facts.dateKey),
        plain: true,
      },
    },
    destinations: [destination],
  });
  return true;
}

/**
 * 전용 채널이 아직 설정되지 않았으면 기존 채널로 보낸다.
 * 채널 ID 봉인 전에 배포해도 결제 알림이 끊기지 않는다.
 */
export function iapDestinations(): NotificationDestination[] {
  return discordDestinationOrFallback("iap", "action-events");
}
