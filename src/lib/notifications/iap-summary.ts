import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  discordDestinationOrFallback,
  type NotificationDestination,
} from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { EMBED_COLOR } from "@/lib/notifications/style";
import type { OperationalEventInput } from "@/lib/platform/operational-events";

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

export function testPurchaseState(
  attributes: Prisma.JsonValue,
): TestPurchaseState {
  if (
    !attributes ||
    typeof attributes !== "object" ||
    Array.isArray(attributes)
  )
    return "unknown";
  const value = (attributes as Prisma.JsonObject).isTestPurchase;
  if (value === true) return "test";
  if (value === false) return "real";
  return "unknown";
}

/** 실제 주문 최초 지급만 보고한다. 성공 이벤트 원장은 수신 라우트가 보존한다. */
export async function recordIapGrant(input: {
  app: {
    id: string;
    slug: string;
    platformAppId: string | null;
    displayName: string;
  };
  event: OperationalEventInput;
}): Promise<boolean> {
  if (testPurchaseState(input.event.attributes as Prisma.JsonValue) !== "real")
    return false;
  return prisma.$transaction(async (tx) => {
    const milestone = await tx.operationalMilestone.upsert({
      where: {
        appId_eventType: { appId: input.app.id, eventType: "iap.real.granted" },
      },
      create: {
        appId: input.app.id,
        eventType: "iap.real.granted",
        firstEventId: input.event.eventId,
        firstObservedAt: new Date(input.event.occurredAt),
      },
      update: {},
    });
    if (milestone.firstEventId !== input.event.eventId || milestone.notifiedAt)
      return false;
    await enqueueNotification(
      {
        dedupeKey: `first-real-iap:${input.app.id}`,
        kind: "OPERATIONAL_EVENT",
        occurredAt: new Date(input.event.occurredAt),
        payload: {
          text: `**${input.app.displayName} · 수신 원장에서 첫 실제 주문 지급을 확인했습니다.**\n${marketLabel(input.event.attributes.platform)} · 상품 ${String(input.event.attributes.entitlementId ?? "제공 안됨")}\n테스트 주문을 제외한 provider 확인 결과입니다. 수신을 시작하기 전의 결제 이력과 금액은 포함하지 않습니다.`,
          report: {
            category: "change",
            reason: "FIRST_CONFIRMED_REAL_PURCHASE",
          },
          embed: {
            title: "실제 결제 지급의 첫 확인",
            color: EMBED_COLOR.SUCCESS,
          },
        },
        destinations: iapDestinations(),
      },
      tx,
    );
    await tx.operationalMilestone.update({
      where: { id: milestone.id },
      data: { notifiedAt: new Date() },
    });
    return true;
  });
}

export function iapDestinations(): NotificationDestination[] {
  return discordDestinationOrFallback("iap", "action-events");
}
