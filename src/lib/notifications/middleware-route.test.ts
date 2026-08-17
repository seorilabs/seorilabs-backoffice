import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");

test("Platform operational event 경로만 세션 대신 route HMAC 인증을 사용한다", () => {
  assert.match(source, /api\/internal\/platform\/operational-events\(\?:\/\|\$\)/);
  assert.doesNotMatch(source, /api\/internal\)\(\?:\/\|\$\)/);
});
