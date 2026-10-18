import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
test("worker와 같은 번들에서 실제 Octokit 등록 POST 자동 재전송을 끈다", () => {
  const dir = mkdtempSync(join(tmpdir(), "metric-transport-test-")), file = join(dir, "transport.cjs");
  try {
    buildSync({ entryPoints: ["scripts/test-metric-issue-transport.ts"], outfile: file, bundle: true, platform: "node", target: "node24", format: "cjs", alias: { "@": "./src" }, logLevel: "silent" });
    const result = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
