import assert from "node:assert/strict";
import test from "node:test";

import {
  platformCatalogForApp,
  platformEntitlementAllowedForApp,
} from "./catalog";

test("느린 이전 앱 카탈로그 응답은 현재 앱 선택과 제출에 쓰지 않는다", () => {
  const appACatalog = {
    appId: "app-a",
    entitlements: ["app_a_premium"],
  };

  assert.equal(platformCatalogForApp(appACatalog, "app-b"), null);
  assert.equal(
    platformEntitlementAllowedForApp(
      appACatalog,
      "app-b",
      "app_a_premium",
    ),
    false,
  );
  assert.equal(
    platformEntitlementAllowedForApp(
      appACatalog,
      "app-a",
      "app_a_premium",
    ),
    true,
  );
});
