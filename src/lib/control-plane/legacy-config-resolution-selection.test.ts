import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextLegacyResolutionTargets } from "./legacy-config-resolution-selection";

describe("nextLegacyResolutionTargets", () => {
  it("IGNORED_NON_OPERATIONAL을 선택하면 다른 target을 제거한다", () => {
    assert.deepEqual(
      nextLegacyResolutionTargets(["CONFIG_REVISION", "STORE_ASSET"], "IGNORED_NON_OPERATIONAL"),
      ["IGNORED_NON_OPERATIONAL"],
    );
  });

  it("다른 target을 선택하면 IGNORED_NON_OPERATIONAL을 해제한다", () => {
    assert.deepEqual(
      nextLegacyResolutionTargets(["IGNORED_NON_OPERATIONAL"], "CONFIG_REVISION"),
      ["CONFIG_REVISION"],
    );
  });

  it("선택된 target을 다시 누르면 제거한다", () => {
    assert.deepEqual(
      nextLegacyResolutionTargets(["CONFIG_REVISION"], "CONFIG_REVISION"),
      [],
    );
  });
});
