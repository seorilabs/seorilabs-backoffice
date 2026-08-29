import assert from "node:assert/strict";
import test from "node:test";

import { repositoryProductPlanningReason } from "@/lib/control-plane/repository-product-readiness";

test("planning product readiness는 candidate/build/source gate를 서로 구분한다", () => {
  assert.equal(repositoryProductPlanningReason("NO_CANDIDATE"), "PRODUCT_SOURCE_CANDIDATE_MISSING");
  assert.equal(repositoryProductPlanningReason("BUILD_TARGET_MISSING"), "PRODUCT_BUILD_TARGET_MISSING");
  assert.equal(repositoryProductPlanningReason("TREE_TRUNCATED"), "PRODUCT_DISCOVERY_NOT_READY");
  assert.equal(repositoryProductPlanningReason(null), "PRODUCT_DISCOVERY_NOT_READY");
});
