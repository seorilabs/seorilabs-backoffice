import type { Prisma } from "@prisma/client";
import {
  destinationOrFallback,
  type NotificationDestination,
} from "@/lib/notifications/destinations";

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

export function iapDestinations(): NotificationDestination[] {
  return destinationOrFallback("iap", "action-events");
}
