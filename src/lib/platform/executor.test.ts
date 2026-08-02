import assert from "node:assert/strict";
import test from "node:test";

import {
  executePlatformOperation,
  isPlatformUnknownOutcomeForTest,
  PlatformOperationUnknownOutcomeError,
  type PlatformOperationsClient,
} from "./executor";

const baseInput = {
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  operation: "platform.iap.grant-entitlement",
  params: {
    appSlug: "lizard-tycoon",
    platformUserId: "pu_01J00000000000000000000000",
    entitlementId: "sp_galaxy_gecko",
    expectedEnvironment: "production",
    serverConfirmation:
      "GRANT lizard-tycoon pu_01J00000000000000000000000 sp_galaxy_gecko",
  },
  actorLogin: "syous",
  reason: "customer_support_compensation",
};

test("지급 요청을 write client에 전달하고 결과에서 식별자를 제거한다", async () => {
  let called: unknown;
  const client: PlatformOperationsClient = {
    async grantEntitlement(request, actor) {
      called = { request, actor };
      return { applied: true, entitlements: ["sp_galaxy_gecko"] };
    },
    async revokeEntitlement() {
      throw new Error("unexpected");
    },
    async resetAppStoreSandbox() {
      throw new Error("unexpected");
    },
  };

  const result = await executePlatformOperation(baseInput, () => client);
  assert.deepEqual(called, {
    request: {
      requestId: baseInput.requestId,
      platformUserId: "pu_01J00000000000000000000000",
      entitlementId: "sp_galaxy_gecko",
      reason: "customer_support_compensation",
      appId: "lizard-tycoon",
      expectedEnvironment: "production",
      confirmation:
        "GRANT lizard-tycoon pu_01J00000000000000000000000 sp_galaxy_gecko",
    },
    actor: "syous",
  });
  assert.deepEqual(result.data, {
    applied: true,
    activeEntitlementCount: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /pu_01J|sp_galaxy_gecko|customer_support_compensation/,
  );
});

test("회수에는 원 지급 requestId를 전달한다", async () => {
  let grantRequestId = "";
  const client: PlatformOperationsClient = {
    async grantEntitlement() {
      throw new Error("unexpected");
    },
    async revokeEntitlement(request) {
      grantRequestId = request.grantRequestId;
      return { applied: false, entitlements: [] };
    },
    async resetAppStoreSandbox() {
      throw new Error("unexpected");
    },
  };

  const result = await executePlatformOperation(
    {
      ...baseInput,
      requestId: "223e4567-e89b-42d3-a456-426614174000",
      operation: "platform.iap.revoke-entitlement",
      params: {
        ...baseInput.params,
        grantRequestId: "123e4567-e89b-42d3-a456-426614174000",
        serverConfirmation:
          "REVOKE lizard-tycoon pu_01J00000000000000000000000 sp_galaxy_gecko 123e4567-e89b-42d3-a456-426614174000",
      },
      reason: "incorrect_grant_correction",
    },
    () => client,
  );
  assert.equal(grantRequestId, "123e4567-e89b-42d3-a456-426614174000");
  assert.match(result.summary, /이미 처리/);
});

test("네트워크·5xx·불명확 envelope만 결과 불명으로 분류한다", () => {
  assert.equal(isPlatformUnknownOutcomeForTest({ status: 0 }), true);
  assert.equal(isPlatformUnknownOutcomeForTest({ status: 503 }), true);
  assert.equal(
    isPlatformUnknownOutcomeForTest({ code: "platform_response_invalid", status: 200 }),
    true,
  );
  assert.equal(isPlatformUnknownOutcomeForTest({ status: 409 }), false);
});

test("결과 불명 오류는 worker가 동일 requestId 재시도를 구분할 수 있다", async () => {
  const client: PlatformOperationsClient = {
    async grantEntitlement() {
      throw { status: 503, code: "unavailable" };
    },
    async revokeEntitlement() {
      throw new Error("unexpected");
    },
    async resetAppStoreSandbox() {
      throw new Error("unexpected");
    },
  };

  await assert.rejects(
    () => executePlatformOperation(baseInput, () => client),
    PlatformOperationUnknownOutcomeError,
  );
});

test("sandbox reset은 Apple 삭제 확인과 동일 requestId를 전달한다", async () => {
  let called: unknown;
  const client: PlatformOperationsClient = {
    async grantEntitlement() {
      throw new Error("unexpected");
    },
    async revokeEntitlement() {
      throw new Error("unexpected");
    },
    async resetAppStoreSandbox(request, actor) {
      called = { request, actor };
      return {
        platformUserId: request.platformUserId,
        resetOrderKeys: ["a".repeat(64), "b".repeat(64)],
      };
    },
  };

  const result = await executePlatformOperation(
    {
      requestId: "323e4567-e89b-42d3-a456-426614174000",
      operation: "platform.iap.reset-app-store-sandbox",
      params: {
        appSlug: "lizard-tycoon",
        platformUserId: "pu_01J00000000000000000000000",
        expectedEnvironment: "sandbox",
        serverConfirmation:
          "RESET lizard-tycoon pu_01J00000000000000000000000",
        appleClearedConfirmed: true,
      },
      actorLogin: "syous",
      reason: "internal_validation",
    },
    () => client,
  );

  assert.deepEqual(called, {
    request: {
      requestId: "323e4567-e89b-42d3-a456-426614174000",
      platformUserId: "pu_01J00000000000000000000000",
      reason: "internal_validation",
      appId: "lizard-tycoon",
      expectedEnvironment: "sandbox",
      confirmation:
        "RESET lizard-tycoon pu_01J00000000000000000000000",
      appleClearedConfirmed: true,
    },
    actor: "syous",
  });
  assert.deepEqual(result.data, { resetOrderCount: 2 });
  assert.doesNotMatch(JSON.stringify(result), /pu_01J|a{64}|b{64}/);
});
