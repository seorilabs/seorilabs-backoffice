import assert from "node:assert/strict";
import test from "node:test";

import {
  lizardEntitlementLabel,
  parseLizardOperatorGrants,
  parseLizardPurchases,
  parseLizardSandboxTesters,
} from "./lizard-tycoon-view";

test("도마뱀 IAP 표 결과는 필요한 필드만 허용한다", () => {
  const purchases = parseLizardPurchases({
    purchases: [
      {
        purchaseRef: "purchase-1",
        testAccountRef: "uid-1",
        platform: "app_store",
        productId: "apple.product",
        entitlementId: "sp_galaxy_gecko",
        state: "active",
        purchasedAt: "2026-07-30T01:00:00.000Z",
        observedAt: "2026-07-30T01:00:00.000Z",
        updatedAt: "2026-07-30T01:00:00.000Z",
        tombstone: false,
      },
    ],
  });
  assert.equal(purchases[0]?.purchaseRef, "purchase-1");
  assert.throws(() =>
    parseLizardPurchases({
      purchases: [{ purchaseRef: "broken" }],
    }),
  );
});

test("Apple Sandbox 계정과 Production 지급 결과를 표 형태로 해석한다", () => {
  const testers = parseLizardSandboxTesters({
    testers: [
      {
        sandboxTesterId: "tester-1",
        accountName: "sandbox@example.com",
        firstName: "Sandbox",
        lastName: "Tester",
        territory: "KOR",
      },
    ],
  });
  const grants = parseLizardOperatorGrants({
    grants: [
      {
        grantRef: "grant-1",
        playerRef: "uid-1",
        entitlementId: "sp_shootingstar_tokay",
        state: "active",
        actorLogin: "operator",
        reason: "CS 지급",
        createdAt: "2026-07-30T01:00:00.000Z",
        updatedAt: "2026-07-30T01:00:00.000Z",
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
      },
    ],
  });
  assert.equal(testers[0]?.accountName, "sandbox@example.com");
  assert.equal(grants[0]?.state, "active");
  assert.equal(lizardEntitlementLabel("sp_galaxy_gecko"), "은하 도마뱀붙이");
});
