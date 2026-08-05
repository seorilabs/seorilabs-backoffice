export const PLATFORM_REFUND_REVIEW_PREFERENCES = [
  "DECLINE",
  "APPROVE",
  "NEUTRAL",
] as const;

export type PlatformRefundReviewPreference =
  (typeof PLATFORM_REFUND_REVIEW_PREFERENCES)[number];

export const PLATFORM_REFUND_REVIEW_REASONS = [
  "verified_fulfillment",
  "customer_refund_supported",
  "insufficient_evidence",
  "internal_validation",
] as const;

export type PlatformRefundReviewDecisionReason =
  (typeof PLATFORM_REFUND_REVIEW_REASONS)[number];

export const PLATFORM_REFUND_REVIEW_STATES = [
  "pending",
  "decided",
  "responded",
  "expired",
  "failed",
] as const;

export type PlatformRefundReviewState =
  (typeof PLATFORM_REFUND_REVIEW_STATES)[number];

export type PlatformRefundReviewDecisionState = Exclude<
  PlatformRefundReviewState,
  "pending"
>;

export function platformRefundReviewConfirmationText(input: {
  appSlug: string;
  reviewId: string;
  refundPreference: PlatformRefundReviewPreference;
}): string {
  return `RESPOND REFUND ${input.appSlug} ${input.reviewId} ${input.refundPreference}`;
}

export function platformRefundReviewPreferenceLabel(
  value: PlatformRefundReviewPreference,
): string {
  switch (value) {
    case "DECLINE":
      return "환불 거절 제안";
    case "APPROVE":
      return "환불 승인 제안";
    case "NEUTRAL":
      return "중립";
  }
}

export function platformRefundReviewReasonLabel(
  value: PlatformRefundReviewDecisionReason,
): string {
  switch (value) {
    case "verified_fulfillment":
      return "이행 확인";
    case "customer_refund_supported":
      return "고객 환불 지원";
    case "insufficient_evidence":
      return "증거 부족";
    case "internal_validation":
      return "내부 검증";
  }
}
