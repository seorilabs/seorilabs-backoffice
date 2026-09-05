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

test("자체 인증하는 internal API만 명시적으로 세션 인증에서 제외한다", () => {
  assert.match(source, /api\/internal\/platform\/operational-events\(\?:\/\|\$\)/);
  // worker/adapter bearer + principal + runtime binding으로 각 route가 401 fail-closed하는
  // P6 agent queue 경계다. 여기서 빠지면 세션 미들웨어가 가로채 로그인 HTML(200)이 돌아간다.
  assert.match(
    source,
    /api\/internal\/\(\?:agents\|agent-adapter\|workflow-bundle-candidate-executor\|approved-caller-reconciliation-executor\)\(\?:\/\|\$\)/,
  );
  assert.doesNotMatch(source, /grafana\/alerts/);
  // `api/internal` 통째 제외는 계속 금지한다 — 새 internal route가 자체 인증 없이 열릴 수 있다.
  assert.doesNotMatch(source, /api\/internal\)\(\?:\/\|\$\)/);
  assert.doesNotMatch(source, /\|internal\)\(\?:\/\|\$\)/);
});

test("자체 bearer token을 검증하는 control-plane API는 세션 인증에서 제외한다", () => {
  assert.match(source, /admin\|control-plane\|health/);
  const routes = routeFiles(join(process.cwd(), "src/app/api/control-plane"));
  assert.ok(routes.length > 0);
  for (const route of routes) {
    assert.match(readFileSync(route, "utf8"), /authenticateInternalRequest\(request, "control-plane"\)/);
  }
});
