import assert from "node:assert/strict";
import test from "node:test";

import { resolvedPlatformAppId } from "./app-id";

test("Platform app ID 바인딩을 저장소 slug보다 우선한다", () => {
  assert.equal(
    resolvedPlatformAppId({ slug: "saju-reader", platformAppId: "ungeul" }),
    "ungeul",
  );
});

test("바인딩이 없는 기존 앱은 저장소 slug를 유지한다", () => {
  assert.equal(
    resolvedPlatformAppId({ slug: "happy-farm", platformAppId: null }),
    "happy-farm",
  );
});
