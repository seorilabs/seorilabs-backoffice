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
      return {
        applied: true,
        entitlements: ["sp_galaxy_gecko"],
        requestId: request.requestId,
        appId: request.appId,
        platformUserId: request.platformUserId,
        entitlementId: request.entitlementId,
        expectedEnvironment: request.expectedEnvironment,
        operation: "grant",
      };
    },
    async revokeEntitlement() {
      throw new Error("unexpected");
    },
    async resetAppStoreSandbox() {
      throw new Error("unexpected");
    },
    async resumeSandboxReset() {
      throw new Error("unexpected");
    },
    async closeSandboxResetNotStarted() {
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
      return {
        applied: false,
        entitlements: [],
        requestId: request.requestId,
        appId: request.appId,
        platformUserId: request.platformUserId,
        entitlementId: request.entitlementId,
        expectedEnvironment: request.expectedEnvironment,
        operation: "revoke",
        grantRequestId: request.grantRequestId,
      };
    },
    async resetAppStoreSandbox() {
      throw new Error("unexpected");
    },
    async resumeSandboxReset() {
      throw new Error("unexpected");
    },
    async closeSandboxResetNotStarted() {
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
  assert.equal(
    isPlatformUnknownOutcomeForTest({ status: 429, code: "rate_limited" }),
    false,
  );
});

test("명시적인 429 rate_limited는 결과 불명이 아니라 확정 실패다", async () => {
  const rateLimited = { status: 429, code: "rate_limited" };
  const client: PlatformOperationsClient = {
    async grantEntitlement() {
      throw rateLimited;
    },
    async revokeEntitlement() {
      throw new Error("unexpected");
    },
    async resetAppStoreSandbox() {
      throw new Error("unexpected");
    },
    async resumeSandboxReset() {
      throw new Error("unexpected");
    },
    async closeSandboxResetNotStarted() {
      throw new Error("unexpected");
    },
  };

  await assert.rejects(
    () => executePlatformOperation(baseInput, () => client),
    (error: unknown) => error === rateLimited,
  );
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
    async resumeSandboxReset() {
      throw new Error("unexpected");
    },
    async closeSandboxResetNotStarted() {
      throw new Error("unexpected");
    },
  };

  await assert.rejects(
    () => executePlatformOperation(baseInput, () => client),
    PlatformOperationUnknownOutcomeError,
  );
});

test("조작 성공 응답 target이 요청과 다르면 결과 불명으로 중단한다", async () => {
  const client: PlatformOperationsClient = {
    async grantEntitlement(request) {
      return {
        applied: true,
        entitlements: [request.entitlementId],
        requestId: "223e4567-e89b-42d3-a456-426614174000",
        appId: request.appId,
        platformUserId: request.platformUserId,
        entitlementId: request.entitlementId,
        expectedEnvironment: request.expectedEnvironment,
        operation: "grant",
      };
    },
    async revokeEntitlement() {
      throw new Error("unexpected");
    },
    async resetAppStoreSandbox() {
      throw new Error("unexpected");
    },
    async resumeSandboxReset() {
      throw new Error("unexpected");
    },
    async closeSandboxResetNotStarted() {
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
        requestId: request.requestId,
        appId: request.appId,
        platformUserId: request.platformUserId,
        expectedEnvironment: "sandbox",
        operation: "sandbox_reset",
        resetOrderKeys: ["a".repeat(64), "b".repeat(64)],
      };
    },
    async resumeSandboxReset() {
      throw new Error("unexpected");
    },
    async closeSandboxResetNotStarted() {
      throw new Error("unexpected");
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

test("sandbox reset 응답의 PUID가 요청과 다르면 결과 불명으로 중단한다", async () => {
  const client: PlatformOperationsClient = {
    async grantEntitlement() {
      throw new Error("unexpected");
    },
    async revokeEntitlement() {
      throw new Error("unexpected");
    },
    async resetAppStoreSandbox() {
      return {
        requestId: "323e4567-e89b-42d3-a456-426614174000",
        appId: "lizard-tycoon",
        platformUserId: "pu_01JWRONG000000000000000000",
        expectedEnvironment: "sandbox",
        operation: "sandbox_reset",
        resetOrderKeys: [],
      };
    },
    async resumeSandboxReset() {
      throw new Error("unexpected");
    },
    async closeSandboxResetNotStarted() {
      throw new Error("unexpected");
    },
  };

  await assert.rejects(
    () =>
      executePlatformOperation(
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
      ),
    PlatformOperationUnknownOutcomeError,
  );
});

test("prepared sandbox reset은 동일 requestId의 resume endpoint로만 재개한다", async () => {
  let called: unknown;
  const resumeRequestId = "423e4567-e89b-42d3-a456-426614174000";
  const client: PlatformOperationsClient = {
    async grantEntitlement() {
      throw new Error("unexpected");
    },
    async revokeEntitlement() {
      throw new Error("unexpected");
    },
    async resetAppStoreSandbox() {
      throw new Error("unexpected");
    },
    async resumeSandboxReset(request, actor) {
      called = { request, actor };
      return {
        requestId: request.requestId,
        appId: request.appId,
        platformUserId: "pu_01J00000000000000000000000",
        expectedEnvironment: "sandbox",
        operation: "sandbox_reset",
        resetOrderKeys: ["a".repeat(64)],
      };
    },
    async closeSandboxResetNotStarted() {
      throw new Error("unexpected");
    },
  };

  const result = await executePlatformOperation(
    {
      requestId: resumeRequestId,
      operation: "platform.iap.reset-app-store-sandbox",
      params: {
        appSlug: "lizard-tycoon",
        resumePreparedReset: true,
        serverConfirmation:
          `RESUME RESET lizard-tycoon ${resumeRequestId}`,
      },
      actorLogin: "reviewer",
      reason: null,
    },
    () => client,
  );

  assert.deepEqual(called, {
    request: {
      requestId: resumeRequestId,
      appId: "lizard-tycoon",
      confirmation: `RESUME RESET lizard-tycoon ${resumeRequestId}`,
    },
    actor: "reviewer",
  });
  assert.deepEqual(result.data, { resetOrderCount: 1 });
  assert.doesNotMatch(JSON.stringify(result), /pu_01J|a{64}/);
});

test("absent sandbox reset은 동일 requestId의 close endpoint로만 영구 종료한다", async () => {
  let called: unknown;
  const closeRequestId = "523e4567-e89b-42d3-a456-426614174000";
  const client: PlatformOperationsClient = {
    async grantEntitlement() {
      throw new Error("unexpected");
    },
    async revokeEntitlement() {
      throw new Error("unexpected");
    },
    async resetAppStoreSandbox() {
      throw new Error("unexpected");
    },
    async resumeSandboxReset() {
      throw new Error("unexpected");
    },
    async closeSandboxResetNotStarted(request, actor) {
      called = { request, actor };
      return {
        requestId: request.requestId,
        appId: request.appId,
        state: "closed_not_started",
        expectedEnvironment: "sandbox",
        operation: "sandbox_reset",
        applied: true,
      };
    },
  };

  const result = await executePlatformOperation(
    {
      requestId: closeRequestId,
      operation: "platform.iap.reset-app-store-sandbox",
      params: {
        appSlug: "lizard-tycoon",
        closeNotStartedReset: true,
        serverConfirmation:
          `CLOSE RESET lizard-tycoon ${closeRequestId}`,
      },
      actorLogin: "reviewer",
      reason: null,
    },
    () => client,
  );

  assert.deepEqual(called, {
    request: {
      requestId: closeRequestId,
      appId: "lizard-tycoon",
      confirmation: `CLOSE RESET lizard-tycoon ${closeRequestId}`,
    },
    actor: "reviewer",
  });
  assert.deepEqual(result.data, { closureApplied: true });
  assert.doesNotMatch(JSON.stringify(result), /platformUserId|entitlementId/);
});

test("sandbox reset 미시작 종료 응답 target이 다르면 local lock을 풀지 못하게 결과 불명으로 본다", async () => {
  const requestId = "623e4567-e89b-42d3-a456-426614174000";
  const client: PlatformOperationsClient = {
    async grantEntitlement() {
      throw new Error("unexpected");
    },
    async revokeEntitlement() {
      throw new Error("unexpected");
    },
    async resetAppStoreSandbox() {
      throw new Error("unexpected");
    },
    async resumeSandboxReset() {
      throw new Error("unexpected");
    },
    async closeSandboxResetNotStarted() {
      return {
        requestId,
        appId: "other-app",
        state: "closed_not_started",
        expectedEnvironment: "sandbox",
        operation: "sandbox_reset",
        applied: true,
      };
    },
  };

  await assert.rejects(
    () =>
      executePlatformOperation(
        {
          requestId,
          operation: "platform.iap.reset-app-store-sandbox",
          params: {
            appSlug: "lizard-tycoon",
            closeNotStartedReset: true,
            serverConfirmation: `CLOSE RESET lizard-tycoon ${requestId}`,
          },
          actorLogin: "reviewer",
          reason: null,
        },
        () => client,
      ),
    PlatformOperationUnknownOutcomeError,
  );
});

test("환불 검토 결정을 write client에 전달하고 safe 결과만 남긴다", async () => {
  const reviewId = "a".repeat(64);
  let called: unknown;
  const client: PlatformOperationsClient = {
    async grantEntitlement() {
      throw new Error("unexpected");
    },
    async revokeEntitlement() {
      throw new Error("unexpected");
    },
    async resetAppStoreSandbox() {
      throw new Error("unexpected");
    },
    async resumeSandboxReset() {
      throw new Error("unexpected");
    },
    async closeSandboxResetNotStarted() {
      throw new Error("unexpected");
    },
    async decideRefundReview(request, actor) {
      called = { request, actor };
      return {
        applied: false,
        requestId: request.requestId,
        appId: request.appId,
        reviewId: request.reviewId,
        expectedEnvironment: request.expectedEnvironment,
        state: "failed",
        refundPreference: request.refundPreference,
        sampleContentProvided: request.sampleContentProvided,
        operation: "refund_review_decision",
      };
    },
  };

  const result = await executePlatformOperation(
    {
      requestId: baseInput.requestId,
      operation: "platform.iap.decide-refund-review",
      params: {
        appSlug: "lizard-tycoon",
        reviewId,
        expectedEnvironment: "production",
        refundPreference: "DECLINE",
        sampleContentProvided: false,
        serverConfirmation:
          `RESPOND REFUND lizard-tycoon ${reviewId} DECLINE`,
      },
      actorLogin: "reviewer",
      reason: "verified_fulfillment",
    },
    () => client,
  );

  assert.deepEqual(called, {
    request: {
      requestId: baseInput.requestId,
      appId: "lizard-tycoon",
      reviewId,
      expectedEnvironment: "production",
      refundPreference: "DECLINE",
      sampleContentProvided: false,
      reason: "verified_fulfillment",
      confirmation: `RESPOND REFUND lizard-tycoon ${reviewId} DECLINE`,
    },
    actor: "reviewer",
  });
  assert.deepEqual(result.data, { applied: false, state: "failed" });
  assert.doesNotMatch(JSON.stringify(result), /pendingRefundToken|orderId|ciphertext/);
});
