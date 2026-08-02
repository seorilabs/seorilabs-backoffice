import assert from "node:assert/strict";
import test from "node:test";

import {
  platformOperationConfirmationText,
  platformRequestIdForSubmission,
  platformSandboxResetCloseConfirmationText,
  platformSandboxResetResumeConfirmationText,
  platformUnknownReconciliationConfirmationText,
} from "./confirmation";

test("지급·회수·sandbox reset 확인 문구를 서버 계약과 같은 순서로 만든다", () => {
  assert.equal(
    platformOperationConfirmationText({
      operation: "platform.iap.grant-entitlement",
      appSlug: "lizard-tycoon",
      platformUserId: "pu_01J00000000000000000000000",
      entitlementId: "premium",
    }),
    "GRANT lizard-tycoon pu_01J00000000000000000000000 premium",
  );
  assert.equal(
    platformOperationConfirmationText({
      operation: "platform.iap.revoke-entitlement",
      appSlug: "lizard-tycoon",
      platformUserId: "pu_01J00000000000000000000000",
      entitlementId: "premium",
      grantRequestId: "123e4567-e89b-42d3-a456-426614174000",
    }),
    "REVOKE lizard-tycoon pu_01J00000000000000000000000 premium 123e4567-e89b-42d3-a456-426614174000",
  );
  assert.equal(
    platformOperationConfirmationText({
      operation: "platform.iap.reset-app-store-sandbox",
      appSlug: "lizard-tycoon",
      platformUserId: "pu_01J00000000000000000000000",
    }),
    "RESET lizard-tycoon pu_01J00000000000000000000000",
  );
});

test("sandbox reset 재개 문구는 앱과 immutable request ID를 결합한다", () => {
  assert.equal(
    platformSandboxResetResumeConfirmationText({
      appSlug: "lizard-tycoon",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
    }),
    "RESUME RESET lizard-tycoon 123e4567-e89b-42d3-a456-426614174000",
  );
});

test("sandbox reset 미시작 종료 문구도 앱과 immutable request ID를 결합한다", () => {
  assert.equal(
    platformSandboxResetCloseConfirmationText({
      appSlug: "lizard-tycoon",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
    }),
    "CLOSE RESET lizard-tycoon 123e4567-e89b-42d3-a456-426614174000",
  );
});

test("같은 payload 재시도는 기존 request ID를 보존한다", () => {
  const previous = { fingerprint: "same", requestId: "preserved-id" };
  assert.equal(
    platformRequestIdForSubmission("same", previous, () => "new-id"),
    "preserved-id",
  );
  assert.equal(
    platformRequestIdForSubmission("changed", previous, () => "new-id"),
    "new-id",
  );
});

test("새로고침 복구 참조도 새 ID를 만들지 않는다", () => {
  assert.equal(
    platformRequestIdForSubmission(
      "re-entered-payload",
      { fingerprint: null, requestId: "existing-id" },
      () => "new-id",
    ),
    "existing-id",
  );
});

test("결과 불명 대조 종료 문구는 판정·앱·request ID를 모두 결합한다", () => {
  assert.equal(
    platformUnknownReconciliationConfirmationText({
      appSlug: "lizard-tycoon",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      resolution: "applied",
    }),
    "RECONCILE APPLIED lizard-tycoon 123e4567-e89b-42d3-a456-426614174000",
  );
  assert.equal(
    platformUnknownReconciliationConfirmationText({
      appSlug: "lizard-tycoon",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      resolution: "not_applied",
    }),
    "RECONCILE NOT_APPLIED lizard-tycoon 123e4567-e89b-42d3-a456-426614174000",
  );
});
