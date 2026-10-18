import assert from "node:assert/strict";
import { test } from "node:test";
import { testPurchaseState, marketLabel } from "./iap-summary";
test("테스트·실제·미확인 주문을 나눠 해석한다", () => {
  assert.equal(testPurchaseState({ isTestPurchase: true }), "test");
  assert.equal(testPurchaseState({ isTestPurchase: false }), "real");
  for (const attributes of [
    {},
    { isTestPurchase: null },
    { isTestPurchase: "false" },
    null,
  ])
    assert.equal(testPurchaseState(attributes), "unknown");
  assert.equal(marketLabel("app_store"), "App Store");
});
