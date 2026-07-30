import assert from "node:assert/strict";
import test from "node:test";

import {
  LIZARD_TYCOON_IAP_OPERATIONS,
  parseLimit,
  requireAccountRef,
  requireLizardOperationIntent,
  requireSandboxEnvironment,
  resetAppStoreSourcesForTest,
  sanitizeEntitlement,
  sanitizePurchase,
  sanitizeRefundReview,
  validateLizardCredentialForTest,
} from "./lizard-tycoon";

test("도마뱀 worker가 지원하는 IAP 오퍼레이션을 고정한다", () => {
  assert.deepEqual(LIZARD_TYCOON_IAP_OPERATIONS, [
    "iap-ledger.recent-purchases",
    "iap-ledger.account-entitlements",
    "iap-ledger.refund-review-queue",
    "iap-ledger.reset-app-store-sandbox",
  ]);
});

test("도마뱀 worker는 sandbox와 제한된 입력만 허용한다", () => {
  assert.equal(requireSandboxEnvironment({ environment: "sandbox" }), "sandbox");
  assert.throws(
    () => requireSandboxEnvironment({ environment: "production" }),
    /sandbox 원장만/,
  );
  assert.equal(parseLimit(undefined), 10);
  assert.equal(parseLimit("20"), 20);
  assert.throws(() => parseLimit(0), /1~20/);
  assert.throws(() => parseLimit(21), /1~20/);
  assert.equal(
    requireAccountRef("firebase_uid-123.test"),
    "firebase_uid-123.test",
  );
  assert.throws(() => requireAccountRef("uid with space"), /형식/);
  assert.doesNotThrow(() =>
    requireLizardOperationIntent(
      "iap-ledger.reset-app-store-sandbox",
      "mutate",
    ),
  );
  assert.throws(
    () =>
      requireLizardOperationIntent(
        "iap-ledger.reset-app-store-sandbox",
        "read",
      ),
    /mutate intent/,
  );
  assert.doesNotThrow(() =>
    requireLizardOperationIntent("iap-ledger.recent-purchases", "read"),
  );
  assert.throws(
    () =>
      requireLizardOperationIntent(
        "iap-ledger.recent-purchases",
        "mutate",
      ),
    /read intent/,
  );
});

test("도마뱀 worker는 전용 Sandbox 운영 서비스 계정만 허용한다", () => {
  const credential = {
    project_id: "lizard-tycoon",
    client_email:
      "iap-backoffice-ops@lizard-tycoon.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
  };
  assert.doesNotThrow(() =>
    validateLizardCredentialForTest(JSON.stringify(credential)),
  );
  assert.throws(
    () =>
      validateLizardCredentialForTest(
        JSON.stringify({
          ...credential,
          client_email:
            "owner-service-account@lizard-tycoon.iam.gserviceaccount.com",
        }),
      ),
    /identity/,
  );
});

test("worker 결과에서 provider token과 영수증을 제거한다", () => {
  const purchase = sanitizePurchase({
    data: () => ({
      uid: "test-account-ref",
      platform: "app_store",
      productId: "product-1",
      entitlementId: "entitlement-1",
      state: "active",
      purchasedAt: "2026-07-30T01:00:00.000Z",
      observedAt: "2026-07-30T01:01:00.000Z",
      updatedAt: "2026-07-30T01:02:00.000Z",
      tombstone: false,
      purchaseToken: "must-not-leak",
      receipt: "must-not-leak",
      signedPayload: "must-not-leak",
    }),
  } as never);
  const entitlement = sanitizeEntitlement({
    id: "entitlement-1",
    data: () => ({
      active: true,
      updatedAt: "2026-07-30T01:02:00.000Z",
      receipt: "must-not-leak",
    }),
  } as never);
  const review = sanitizeRefundReview({
    id: "review-1",
    data: () => ({
      orderId: "order-1",
      refundReason: 1,
      observedAt: "2026-07-30T01:00:00.000Z",
      dueAt: "2026-07-31T01:00:00.000Z",
      status: "pending",
      purchaseToken: "must-not-leak",
    }),
  } as never);

  assert.deepEqual(purchase, {
    testAccountRef: "test-account-ref",
    platform: "app_store",
    productId: "product-1",
    entitlementId: "entitlement-1",
    state: "active",
    purchasedAt: "2026-07-30T01:00:00.000Z",
    observedAt: "2026-07-30T01:01:00.000Z",
    updatedAt: "2026-07-30T01:02:00.000Z",
    tombstone: false,
  });
  assert.deepEqual(entitlement, {
    entitlementId: "entitlement-1",
    active: true,
    updatedAt: "2026-07-30T01:02:00.000Z",
  });
  assert.deepEqual(review, {
    reviewId: "review-1",
    orderId: "order-1",
    refundReason: 1,
    observedAt: "2026-07-30T01:00:00.000Z",
    dueAt: "2026-07-31T01:00:00.000Z",
    status: "pending",
  });
  assert.doesNotMatch(
    JSON.stringify({ purchase, entitlement, review }),
    /must-not-leak/,
  );
});

test("Apple Sandbox 초기화는 App Store source만 revoked로 전이한다", () => {
  const resetAt = "2026-07-30T02:00:00.000Z";
  const reset = resetAppStoreSourcesForTest(
    {
      appleActive: {
        platform: "app_store",
        productId: "apple.product",
        state: "active",
        purchasedAt: "2026-07-30T01:00:00.000Z",
        observedAt: "2026-07-30T01:00:00.000Z",
        updatedAt: "2026-07-30T01:00:00.000Z",
      },
      applePending: {
        platform: "app_store",
        productId: "apple.pending",
        state: "pending",
        observedAt: "2026-07-30T01:10:00.000Z",
        updatedAt: "2026-07-30T01:10:00.000Z",
      },
      googleActive: {
        platform: "google_play",
        productId: "google.product",
        state: "active",
        observedAt: "2026-07-30T01:20:00.000Z",
        updatedAt: "2026-07-30T01:20:00.000Z",
      },
    },
    resetAt,
  );

  assert.equal(reset.changed, true);
  assert.equal(reset.active, true);
  assert.deepEqual(reset.sources.appleActive, {
    platform: "app_store",
    productId: "apple.product",
    state: "revoked",
    purchasedAt: "2026-07-30T01:00:00.000Z",
    observedAt: resetAt,
    updatedAt: resetAt,
  });
  assert.equal(reset.sources.applePending.state, "revoked");
  assert.equal(reset.sources.googleActive.state, "active");
});

test("Apple source만 있으면 초기화 후 entitlement가 비활성화되고 재실행은 멱등이다", () => {
  const source = {
    onlyApple: {
      platform: "app_store",
      productId: "apple.product",
      state: "active",
      observedAt: "2026-07-30T01:00:00.000Z",
      updatedAt: "2026-07-30T01:00:00.000Z",
    },
  };
  const first = resetAppStoreSourcesForTest(
    source,
    "2026-07-30T02:00:00.000Z",
  );
  const second = resetAppStoreSourcesForTest(
    first.sources,
    "2026-07-30T03:00:00.000Z",
  );

  assert.equal(first.active, false);
  assert.equal(first.changed, true);
  assert.equal(second.active, false);
  assert.equal(second.changed, false);
  assert.deepEqual(second.sources, first.sources);
});

test("손상된 entitlement source는 부분 초기화하지 않고 중단한다", () => {
  assert.throws(
    () =>
      resetAppStoreSourcesForTest(
        {
          bad: {
            platform: "app_store",
            productId: "apple.product",
            state: "unknown",
          },
        },
        "2026-07-30T02:00:00.000Z",
      ),
    /source 필드/,
  );
});
