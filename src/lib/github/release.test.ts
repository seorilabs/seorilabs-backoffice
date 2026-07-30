import assert from "node:assert/strict";
import test from "node:test";
import { stableVersionTags } from "@/lib/core/stable-semver";

test("릴리즈 목록에서 2자리·NaN 태그를 제외하고 stable SemVer만 정렬한다", () => {
  const tags = stableVersionTags([
    { name: "v27.1.NaN", sha: "bad-nan" },
    { name: "v27.1", sha: "legacy" },
    { name: "v1.0.11", sha: "old" },
    { name: "v1.0.12", sha: "new" },
    { name: "not-a-version", sha: "other" },
  ]);

  assert.deepEqual(tags, [
    { name: "v1.0.12", sha: "new" },
    { name: "v1.0.11", sha: "old" },
  ]);
});
