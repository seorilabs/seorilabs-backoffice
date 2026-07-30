import assert from "node:assert/strict";
import test from "node:test";

import {
  LIZARD_TYCOON_IAP_OPERATIONS,
  parseLimit,
  requireAccountRef,
  requireSandboxEnvironment,
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
  ]);
});

test("도마뱀 worker는 sandbox와 제한된 조회 입력만 허용한다", () => {
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
});

test("도마뱀 worker는 전용 read-only 서비스 계정만 허용한다", () => {
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
