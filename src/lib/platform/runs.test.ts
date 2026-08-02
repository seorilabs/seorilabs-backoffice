import assert from "node:assert/strict";
import test from "node:test";

import { preparePlatformOperation } from "./operations";
import {
  platformAuditPayloadForTest,
  retryUnknownUpdateForTest,
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
