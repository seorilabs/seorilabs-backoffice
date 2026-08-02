import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_OPERATION_DEFINITIONS,
  platformOperationConfirmationText,
  preparePlatformOperation,
  prepareQueuedPlatformOperation,
} from "./operations";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const grantRequestId = "323e4567-e89b-42d3-a456-426614174000";
const platformUserId = "pu_01J00000000000000000000000";

function grantInput() {
  return {
    operation: "platform.iap.grant-entitlement",
    requestId,
    appSlug: "lizard-tycoon",
    platformUserId,
    entitlementId: "sp_galaxy_gecko",
    reason: "customer_support_compensation",
    expectedEnvironment: "production",
    serverConfirmation:
      "GRANT lizard-tycoon pu_01J00000000000000000000000 sp_galaxy_gecko",
  };
}

test("중앙 플랫폼 write operation은 manifest 없이 고정 allowlist에서 준비한다", () => {
  const prepared = preparePlatformOperation(grantInput());

  assert.equal(prepared.operationKey, "platform.iap.grant-entitlement");
  assert.equal(prepared.operation.intent, "mutate");
  assert.equal(
    prepared.operation,
    PLATFORM_OPERATION_DEFINITIONS["platform.iap.grant-entitlement"],
  );
  assert.equal(prepared.appSlug, "lizard-tycoon");
  assert.equal(prepared.params.platformUserId, platformUserId);
  assert.equal(prepared.reason, "customer_support_compensation");
  assert.equal("reason" in prepared.params, false);
  assert.equal("requestId" in prepared.params, false);
});

test("조회와 선언되지 않은 operation 및 미지 필드를 거부한다", () => {
  assert.throws(
    () =>
      preparePlatformOperation({
        ...grantInput(),
        operation: "platform.iap.user-entitlements",
      }),
    /허용되지 않은 플랫폼 오퍼레이션/,
  );
  assert.throws(
    () => preparePlatformOperation({ ...grantInput(), token: "secret" }),
    /Unrecognized key|인식되지 않은 키/i,
  );
});

test("UUID, app slug, PUID, entitlement, reason, 환경, 서버 확인을 엄격 검증한다", () => {
  const invalidCases: Array<[string, unknown, RegExp]> = [
    ["requestId", "not-uuid", /UUID v4/],
    ["appSlug", "Seori/App", /appSlug/],
    ["platformUserId", "pu_short", /pu_ \+ ULID/],
    [
      "platformUserId",
      "pu_81J00000000000000000000000",
      /pu_ \+ ULID/,
    ],
    ["entitlementId", "bad entitlement", /entitlementId/],
    ["reason", "   ", /변경 사유/],
    ["reason", "user@example.com 보상", /변경 사유/],
    ["expectedEnvironment", "staging", /Invalid enum|열거형/i],
    ["serverConfirmation", "", /서버 확인 문구/],
  ];

  for (const [key, value, expected] of invalidCases) {
    assert.throws(
      () => preparePlatformOperation({ ...grantInput(), [key]: value }),
      expected,
      key,
    );
  }
  assert.throws(
    () =>
      preparePlatformOperation({
        ...grantInput(),
        serverConfirmation: "GRANT 다른 요청",
      }),
    /정확히 일치/,
  );
});

test("회수는 별도의 원 지급 UUID를 요구한다", () => {
  const base = {
    ...grantInput(),
    operation: "platform.iap.revoke-entitlement",
    grantRequestId,
    serverConfirmation: platformOperationConfirmationText({
      operation: "platform.iap.revoke-entitlement",
      appSlug: "lizard-tycoon",
      platformUserId,
      entitlementId: "sp_galaxy_gecko",
      grantRequestId,
    }),
  };
  const prepared = preparePlatformOperation(base);
  assert.equal(prepared.params.grantRequestId, grantRequestId);

  assert.throws(
    () => preparePlatformOperation({ ...base, grantRequestId: undefined }),
    /Required|필수/i,
  );
  assert.throws(
    () => preparePlatformOperation({ ...base, grantRequestId: requestId }),
    /달라야/,
  );
});

test("sandbox reset은 sandbox 환경과 Apple 삭제 확인을 강제한다", () => {
  const base = {
    operation: "platform.iap.reset-app-store-sandbox",
    requestId,
    appSlug: "lizard-tycoon",
    platformUserId,
    reason: "internal_validation",
    expectedEnvironment: "sandbox",
    serverConfirmation: `RESET lizard-tycoon ${platformUserId}`,
    appleClearedConfirmed: true,
  };
  const prepared = preparePlatformOperation(base);
  assert.equal(
    prepared.operationKey,
    "platform.iap.reset-app-store-sandbox",
  );
  assert.equal(prepared.params.appleClearedConfirmed, true);
  assert.equal("entitlementId" in prepared.params, false);

  assert.throws(
    () =>
      preparePlatformOperation({
        ...base,
        expectedEnvironment: "production",
      }),
    /Invalid literal|리터럴/i,
  );
  assert.throws(
    () =>
      preparePlatformOperation({
        ...base,
        appleClearedConfirmed: false,
      }),
    /Invalid literal|리터럴/i,
  );
});

test("worker는 DB params도 동일 계약으로 재검증한다", () => {
  const prepared = preparePlatformOperation(grantInput());
  const queued = prepareQueuedPlatformOperation({
    requestId: prepared.requestId,
    operation: prepared.operationKey,
    params: prepared.params,
    reason: prepared.reason,
  });
  assert.deepEqual(queued.params, prepared.params);

  assert.throws(
    () =>
      prepareQueuedPlatformOperation({
        requestId,
        operation: prepared.operationKey,
        params: { ...prepared.params, token: "injected" },
        reason: prepared.reason,
      }),
    /Unrecognized key|인식되지 않은 키/i,
  );
});
