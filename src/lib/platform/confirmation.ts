import type { PlatformOperationKey } from "./operations";

export interface PlatformConfirmationInput {
  operation: PlatformOperationKey;
  appSlug: string;
  platformUserId: string;
  entitlementId?: string;
  grantRequestId?: string;
}

export type PlatformUnknownReconciliationResolution =
  | "applied"
  | "not_applied";

/** 만료된 결과 불명을 사람이 원장과 대조한 뒤 닫을 때 쓰는 별도 확인 문구. */
export function platformUnknownReconciliationConfirmationText(input: {
  appSlug: string;
  requestId: string;
  resolution: PlatformUnknownReconciliationResolution;
}): string {
  const outcome = input.resolution === "applied" ? "APPLIED" : "NOT_APPLIED";
  return `RECONCILE ${outcome} ${input.appSlug} ${input.requestId}`;
}

/** prepared reset intent를 immutable requestId 그대로 재개하는 확인 문구. */
export function platformSandboxResetResumeConfirmationText(input: {
  appSlug: string;
  requestId: string;
}): string {
  return `RESUME RESET ${input.appSlug} ${input.requestId}`;
}

/** reset intent가 없음을 영구 확정하는 close 요청의 확인 문구. */
export function platformSandboxResetCloseConfirmationText(input: {
  appSlug: string;
  requestId: string;
}): string {
  return `CLOSE RESET ${input.appSlug} ${input.requestId}`;
}

/** Platform Admin API가 비교하는 typed confirmation 문구의 단일 조립 규칙. */
export function platformOperationConfirmationText(
  input: PlatformConfirmationInput,
): string {
  if (input.operation === "platform.iap.grant-entitlement") {
    return `GRANT ${input.appSlug} ${input.platformUserId} ${input.entitlementId}`;
  }
  if (input.operation === "platform.iap.revoke-entitlement") {
    return `REVOKE ${input.appSlug} ${input.platformUserId} ${input.entitlementId} ${input.grantRequestId ?? ""}`;
  }
  return `RESET ${input.appSlug} ${input.platformUserId}`;
}

/** 응답 유실 뒤 같은 payload를 다시 실행할 때 기존 멱등 키를 보존한다. */
export function platformRequestIdForSubmission(
  fingerprint: string,
  previous: { fingerprint: string | null; requestId: string } | null,
  create: () => string,
): string {
  return previous &&
    (previous.fingerprint === null || previous.fingerprint === fingerprint)
    ? previous.requestId
    : create();
}
