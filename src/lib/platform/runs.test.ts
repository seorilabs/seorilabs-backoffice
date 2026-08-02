import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@prisma/client";

import {
  PLATFORM_MIN_EXECUTION_WINDOW_MS,
  PlatformOperationInputError,
  preparePlatformOperation,
} from "./operations";
import {
  assertSandboxResetReconciliationForTest,
  platformAuditPayloadForTest,
  platformBlockingReferenceForTest,
  platformRetryExpiryThresholdForTest,
  reconcileExpiredUnknownPlatformOperation,
  reconciledUnknownUpdateForTest,
  reconciliationAuditPayloadForTest,
  retryUnknownUpdateForTest,
  retryUnknownWhereForTest,
  sandboxResetCloseUpdateForTest,
  sandboxResetResumeUpdateForTest,
} from "./runs";

test("플랫폼 enqueue 감사 payload에는 param key만 남고 값과 reason은 없다", () => {
  const prepared = preparePlatformOperation({
    operation: "platform.iap.grant-entitlement",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    appSlug: "lizard-tycoon",
    platformUserId: "pu_01J00000000000000000000000",
    entitlementId: "sp_galaxy_gecko",
    reason: "customer_support_compensation",
    expectedEnvironment: "production",
    serverConfirmation:
      "GRANT lizard-tycoon pu_01J00000000000000000000000 sp_galaxy_gecko",
  });

  const payload = platformAuditPayloadForTest(prepared);
  assert.deepEqual(payload.paramKeys, [
    "appSlug",
    "entitlementId",
    "expectedEnvironment",
    "platformUserId",
    "serverConfirmation",
  ]);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /pu_01J/);
  assert.doesNotMatch(serialized, /sp_galaxy_gecko/);
  assert.doesNotMatch(serialized, /customer_support_compensation/);
  assert.match(serialized, /seorilabs\/platform/);
});

test("동일-ID 수동 retry는 최초 command expiry를 연장하지 않는다", () => {
  const originalExpiry = new Date("2026-08-03T00:00:00.000Z");
  const update = retryUnknownUpdateForTest({
    expiresAt: originalExpiry,
  });

  assert.equal(update.expiresAt, originalExpiry);
  assert.equal(update.expiresAt.getTime(), originalExpiry.getTime());
});

test("동일-ID retry는 실행 여유와 미삭제 payload를 같은 CAS에서 재검증한다", () => {
  const now = new Date("2026-08-02T23:59:00.000Z");
  const threshold = platformRetryExpiryThresholdForTest(now);
  assert.equal(
    threshold.getTime() - now.getTime(),
    PLATFORM_MIN_EXECUTION_WINDOW_MS,
  );
  assert.deepEqual(retryUnknownWhereForTest("run-1", threshold), {
    id: "run-1",
    status: "FAILED",
    error: "platform_outcome_unknown",
    redactedAt: null,
    params: { not: Prisma.DbNull },
    reason: { not: null },
    expiresAt: { gt: threshold },
  });
  const resumeWhere = retryUnknownWhereForTest("run-1", threshold, true);
  assert.equal("reason" in resumeWhere, false);
});

test("만료 unknown 대조 종료는 payload를 복구하지 않고 비차단 판정만 남긴다", () => {
  const now = new Date("2026-08-03T00:00:00.000Z");
  const update = reconciledUnknownUpdateForTest("not_applied", now);

  assert.equal(update.status, "FAILED");
  assert.equal(update.error, "platform_outcome_reconciled_not_applied");
  assert.equal(update.reason, null);
  assert.equal(update.redactedAt, now);
  assert.equal(update.params, Prisma.DbNull);
  assert.match(update.summary, /미적용/);
});

test("대조 감사 payload에는 판정과 request ID만 있고 typed 문구는 없다", () => {
  const payload = reconciliationAuditPayloadForTest({
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    operation: "platform.iap.grant-entitlement",
    resolution: "applied",
  });

  assert.equal(payload.resolution, "applied");
  assert.equal(payload.confirmationPolicy, "typed_exact");
  assert.equal("confirmation" in payload, false);
  assert.equal("platformUserId" in payload, false);
});

test("만료 unknown 대조 종료는 DB 접근 전에 exact typed confirmation을 검증한다", async () => {
  await assert.rejects(
    () =>
      reconcileExpiredUnknownPlatformOperation({
        appId: "app-1",
        appSlug: "lizard-tycoon",
        actorLogin: "syous",
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        resolution: "not_applied",
        confirmation: "RECONCILE NOT_APPLIED wrong-app wrong-id",
      }),
    (error: unknown) =>
      error instanceof PlatformOperationInputError &&
      /확인 문구/.test(error.message),
  );
});

test("서버 blocking row는 requestId·app·operation·상태만 브라우저에 노출한다", () => {
  const reference = platformBlockingReferenceForTest(
    "lizard-tycoon",
    {
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      operation: "platform.iap.grant-entitlement",
      status: "FAILED",
      error: "platform_outcome_unknown",
      expiresAt: new Date("2026-08-02T00:00:00.000Z"),
      platformUserId: "pu_must_not_leak",
      reason: "must_not_leak",
    } as never,
    new Date("2026-08-03T00:00:00.000Z"),
  );

  assert.deepEqual(reference, {
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    appSlug: "lizard-tycoon",
    operation: "platform.iap.grant-entitlement",
    state: "expired_unknown",
  });
  assert.doesNotMatch(JSON.stringify(reference), /pu_must|must_not_leak/);
});

test("처리 중 server blocker는 expired 대조 UI로 성급히 전환하지 않는다", () => {
  const reference = platformBlockingReferenceForTest(
    "lizard-tycoon",
    {
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      operation: "platform.iap.reset-app-store-sandbox",
      status: "PROCESSING",
      error: "platform_outcome_unknown",
      expiresAt: new Date("2026-08-02T00:00:00.000Z"),
    } as never,
    new Date("2026-08-03T00:00:00.000Z"),
  );
  assert.equal(reference.state, "in_progress");
});

test("sandbox reset 대조는 remote durable state와 판정을 강제 결합한다", () => {
  assert.doesNotThrow(() =>
    assertSandboxResetReconciliationForTest("completed", "applied"),
  );
  assert.doesNotThrow(() =>
    assertSandboxResetReconciliationForTest(
      "closed_not_started",
      "not_applied",
    ),
  );
  assert.throws(
    () => assertSandboxResetReconciliationForTest("prepared", "applied"),
    /동일 request ID로 재개/,
  );
  assert.throws(
    () => assertSandboxResetReconciliationForTest("completed", "not_applied"),
    /적용 확인으로만/,
  );
  assert.throws(
    () => assertSandboxResetReconciliationForTest("absent", "not_applied"),
    /영구 미시작 종료/,
  );
  assert.throws(
    () =>
      assertSandboxResetReconciliationForTest(
        "closed_not_started",
        "applied",
      ),
    /미적용 확인으로만/,
  );
  assert.throws(
    () => assertSandboxResetReconciliationForTest(undefined, "not_applied"),
    /상태를 확인하지 못해/,
  );
});

test("prepared reset 재개는 PII 없이 같은 requestId의 worker envelope만 복구한다", () => {
  const now = new Date("2026-08-03T00:00:00.000Z");
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const update = sandboxResetResumeUpdateForTest({
    appSlug: "lizard-tycoon",
    requestId,
    actorLogin: "reviewer",
    confirmation: `RESUME RESET lizard-tycoon ${requestId}`,
    now,
  });

  assert.equal(update.status, "PENDING");
  assert.equal(update.error, "platform_outcome_unknown");
  assert.equal(update.reason, null);
  assert.equal(update.redactedAt, null);
  assert.equal(update.expiresAt.getTime() - now.getTime(), 24 * 60 * 60 * 1_000);
  assert.deepEqual(update.params, {
    appSlug: "lizard-tycoon",
    resumePreparedReset: true,
    serverConfirmation: `RESUME RESET lizard-tycoon ${requestId}`,
  });
  assert.doesNotMatch(JSON.stringify(update), /platformUserId|entitlementId/);

  assert.throws(
    () =>
      sandboxResetResumeUpdateForTest({
        appSlug: "lizard-tycoon",
        requestId,
        actorLogin: "reviewer",
        confirmation: "RESUME RESET wrong",
        now,
      }),
    /정확히 일치/,
  );
});

test("absent reset 종료는 PII 없이 같은 requestId의 close worker envelope만 만든다", () => {
  const now = new Date("2026-08-03T00:00:00.000Z");
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const update = sandboxResetCloseUpdateForTest({
    appSlug: "lizard-tycoon",
    requestId,
    actorLogin: "reviewer",
    confirmation: `CLOSE RESET lizard-tycoon ${requestId}`,
    now,
  });

  assert.equal(update.status, "PENDING");
  assert.equal(update.error, "platform_outcome_unknown");
  assert.equal(update.reason, null);
  assert.equal(update.redactedAt, null);
  assert.deepEqual(update.params, {
    appSlug: "lizard-tycoon",
    closeNotStartedReset: true,
    serverConfirmation: `CLOSE RESET lizard-tycoon ${requestId}`,
  });
  assert.doesNotMatch(JSON.stringify(update), /platformUserId|entitlementId/);
});
