import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");

test("서명된 internal webhook 두 경로만 세션 인증에서 제외한다", () => {
  assert.match(source, /api\/internal\/\(\?:platform\/operational-events\|grafana\/alerts\)\(\?:\/\|\$\)/);
  assert.doesNotMatch(source, /api\/internal\)\(\?:\/\|\$\)/);
});
