import type {
  PlatformEntitlement,
  PlatformOperatorRecord,
  PlatformOrder,
  PlatformRefundReview,
  PlatformUser,
} from "@/lib/platform/client";

const PLATFORM_USER_ID = /^pu_[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const SUPPORT_CODE = /^[A-Z]{1,3}-[0-9A-HJKMNP-TV-Z]{8}$/i;

export class PlatformReadInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformReadInputError";
  }
}

export interface PlatformEntitlementSummary {
  entitlementId: string;
  active: boolean;
  updatedAt: string;
  sources: Array<{
    platform: string;
    productId: string;
    state: string;
    observedAt: string;
  }>;
}

export function normalizePlatformReference(reference: string): string {
  const value = reference.trim();
  if (!PLATFORM_USER_ID.test(value) && !SUPPORT_CODE.test(value)) {
    throw new PlatformReadInputError(
      "플랫폼 사용자 ID 또는 지원 코드 형식을 확인하세요.",
    );
  }
  if (value.toLowerCase().startsWith("pu_")) {
    return `pu_${value.slice(3).toUpperCase()}`;
  }
  return value.toUpperCase();
}

export function isPlatformUserId(reference: string): boolean {
  return PLATFORM_USER_ID.test(reference);
}

export function publicPlatformUser(user: PlatformUser): PlatformUser {
  return {
    platformUserId: user.platformUserId,
    appId: user.appId,
    supportCode: user.supportCode,
    isAnonymous: user.isAnonymous,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
  };
}

export function publicPlatformOrder(order: PlatformOrder): PlatformOrder {
  return {
    orderKey: order.orderKey,
    appId: order.appId,
    platformUserId: order.platformUserId,
    entitlementId: order.entitlementId,
    platform: order.platform,
    productId: order.productId,
    state: order.state,
    purchasedAt: order.purchasedAt,
    observedAt: order.observedAt,
    tombstone: order.tombstone,
  };
}

export function publicPlatformOperatorRecord(
  record: PlatformOperatorRecord,
): PlatformOperatorRecord {
  return {
    requestId: record.requestId,
    grantRequestId: record.grantRequestId,
    platformUserId: record.platformUserId,
    entitlementId: record.entitlementId,
    actorLogin: record.actorLogin,
    reason: record.reason,
    appId: record.appId,
    createdAt: record.createdAt,
    kind: record.kind,
  };
}

/** 브라우저에는 Admin API의 명시 safe projection만 다시 투영한다. */
export function publicPlatformRefundReview(
  review: PlatformRefundReview,
): PlatformRefundReview {
  return {
    reviewId: review.reviewId,
    appId: review.appId,
    expectedEnvironment: review.expectedEnvironment,
    state: review.state,
    refundReason: review.refundReason,
    receivedAt: review.receivedAt,
    dueAt: review.dueAt,
    requestId: review.requestId,
    refundPreference: review.refundPreference,
    sampleContentProvided: review.sampleContentProvided,
    decisionReason: review.decisionReason,
    decidedAt: review.decidedAt,
    respondedAt: review.respondedAt,
    failedAt: review.failedAt,
    expiredAt: review.expiredAt,
    lastErrorCode: review.lastErrorCode,
  };
}

export function publicPlatformEntitlement(
  entitlement: PlatformEntitlement,
): PlatformEntitlementSummary {
  return {
    entitlementId: entitlement.entitlementId,
    active: entitlement.active,
    updatedAt: entitlement.updatedAt,
    sources: entitlement.sources.map((source) => ({
      platform: source.platform,
      productId: source.productId,
      state: source.state,
      observedAt: source.observedAt,
    })),
  };
}
