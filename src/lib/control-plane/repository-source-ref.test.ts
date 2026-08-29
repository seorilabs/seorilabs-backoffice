import assert from "node:assert/strict";
import test from "node:test";

import { repositoryDefaultBranchRef } from "@/lib/control-plane/repository-source-ref";

test("GitHub registered default branch를 exact heads ref로만 변환한다", () => {
  assert.equal(repositoryDefaultBranchRef("main"), "refs/heads/main");
  assert.equal(repositoryDefaultBranchRef("develop"), "refs/heads/develop");
  assert.equal(repositoryDefaultBranchRef("release/2026-08"), "refs/heads/release/2026-08");
  assert.equal(repositoryDefaultBranchRef(null), null);
  assert.equal(repositoryDefaultBranchRef("refs/heads/main"), null);
  assert.equal(repositoryDefaultBranchRef("bad\0branch"), null);
  assert.equal(repositoryDefaultBranchRef("bad\nbranch"), null);
  assert.equal(repositoryDefaultBranchRef("x".repeat(256)), null);
});
