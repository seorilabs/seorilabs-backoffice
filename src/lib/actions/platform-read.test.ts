import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizePlatformReference,
  publicPlatformEntitlement,
  publicPlatformOrder,
} from "@/lib/platform/read-contract";

describe("플랫폼 사용자 참조", () => {
  it("PUID와 지원 코드를 정규화한다", () => {
    assert.equal(
      normalizePlatformReference(" pu_01jabcde0123456789abcdfghj "),
      "pu_01JABCDE0123456789ABCDFGHJ",
    );
    assert.equal(normalizePlatformReference("lt-abcd1234"), "LT-ABCD1234");
  });

  it("이메일과 임의 문자열을 거부한다", () => {
    assert.throws(() => normalizePlatformReference("user@example.com"));
    assert.throws(() => normalizePlatformReference("pu_short"));
    assert.throws(() =>
      normalizePlatformReference("pu_81J00000000000000000000000"),
    );
  });
});

describe("플랫폼 브라우저 응답 최소화", () => {
  it("Admin API의 미지 필드와 provider order ID를 브라우저 DTO에서 제거한다", () => {
    const order = publicPlatformOrder({
      orderKey: "safe-order",
      appId: "lizard-tycoon",
      platformUserId: "pu_01J00000000000000000000000",
      entitlementId: "premium",
      platform: "app_store",
      productId: "premium.sku",
      state: "active",
      purchasedAt: "2026-08-02T00:00:00Z",
      observedAt: "2026-08-02T00:00:00Z",
      tombstone: false,
      providerOrderId: "must-not-reach-browser",
      futureCredential: "must-not-reach-browser",
    } as never);

    const serialized = JSON.stringify(order);
    assert.doesNotMatch(serialized, /must-not-reach-browser/);
    assert.deepEqual(Object.keys(order).sort(), [
      "appId",
      "entitlementId",
      "observedAt",
      "orderKey",
      "platform",
      "platformUserId",
      "productId",
      "purchasedAt",
      "state",
      "tombstone",
    ]);
  });

  it("entitlement source의 내부 order key를 브라우저 DTO에서 제거한다", () => {
    const entitlement = publicPlatformEntitlement({
      entitlementId: "premium",
      active: true,
      updatedAt: "2026-08-02T00:00:00Z",
      sources: [
        {
          platform: "operator",
          productId: "premium",
          state: "active",
          orderKey: "internal-source-key",
          observedAt: "2026-08-02T00:00:00Z",
        },
      ],
    });

    assert.doesNotMatch(JSON.stringify(entitlement), /internal-source-key/);
  });
});
