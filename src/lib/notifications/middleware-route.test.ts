import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");

test("서명된 operational-events webhook만 세션 인증에서 제외한다", () => {
  assert.match(source, /api\/internal\/platform\/operational-events\(\?:\/\|\$\)/);
  assert.doesNotMatch(source, /grafana\/alerts/);
  assert.doesNotMatch(source, /api\/internal\)\(\?:\/\|\$\)/);
});
