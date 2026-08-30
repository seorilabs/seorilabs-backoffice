import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

test("stable 태그 원장은 전체 GitHub 태그 페이지를 읽은 뒤 limit을 적용한다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/github/release.ts"), "utf8");
  const start = source.indexOf("export async function listVersionTags(");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /octokit\.paginate\(octokit\.rest\.repos\.listTags/);
  assert.match(body, /stableVersionTags\([\s\S]*\)\.slice\(0, limit\)/);
  assert.doesNotMatch(body, /per_page:\s*limit/);
});
