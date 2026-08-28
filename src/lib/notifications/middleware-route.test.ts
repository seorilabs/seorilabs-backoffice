import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

test("서명된 operational-events webhook만 세션 인증에서 제외한다", () => {
  assert.match(source, /api\/internal\/platform\/operational-events\(\?:\/\|\$\)/);
  assert.doesNotMatch(source, /grafana\/alerts/);
  assert.doesNotMatch(source, /api\/internal\)\(\?:\/\|\$\)/);
});

test("자체 bearer token을 검증하는 control-plane API는 세션 인증에서 제외한다", () => {
  assert.match(source, /admin\|control-plane\|health/);
  const routes = routeFiles(join(process.cwd(), "src/app/api/control-plane"));
  assert.ok(routes.length > 0);
  for (const route of routes) {
    assert.match(readFileSync(route, "utf8"), /authenticateInternalRequest\(request, "control-plane"\)/);
  }
});
