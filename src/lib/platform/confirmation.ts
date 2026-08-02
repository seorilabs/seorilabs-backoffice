import type { PlatformOperationKey } from "./operations";

export interface PlatformConfirmationInput {
  operation: PlatformOperationKey;
  appSlug: string;
  platformUserId: string;
  entitlementId?: string;
  grantRequestId?: string;
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
