import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `src/middleware.ts`의 matcher는 Next.js가 빌드 시점에 정적으로 읽는 문자열이라
 * 모듈을 import하면 Auth.js edge 런타임까지 끌려온다. 계약 회귀는 소스의 정규식만
 * 뽑아 직접 평가한다.
 */
function middlewareMatchers(): RegExp[] {
  const source = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
  const matcherBlock = /matcher:\s*\[([\s\S]*?)\]/u.exec(source);
  assert.ok(matcherBlock, "middleware config에서 matcher 배열을 찾지 못했다");
  const patterns = [...matcherBlock[1].matchAll(/"((?:[^"\\]|\\.)*)"/gu)]
    .map((match) => JSON.parse(`"${match[1]}"`) as string);
  assert.ok(patterns.length > 0, "matcher 패턴이 비어 있다");
  return patterns.map((pattern) => new RegExp(`^${pattern}$`, "u"));
}

function sessionProtected(pathname: string): boolean {
  return middlewareMatchers().some((matcher) => matcher.test(pathname));
}

function routePaths(relativeRoot: string): string[] {
  const root = join(process.cwd(), "src/app", relativeRoot);
  const found: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}/${entry}`);
      } else if (entry === "route.ts") {
        found.push(prefix);
      }
    }
  };
  walk(root, relativeRoot);
  return found;
}

/**
 * 자체 토큰·mTLS·HMAC으로 fail-closed 인증하는 API가 세션 미들웨어에 가로채이면
 * 핸들러에 도달하지 못하고 로그인 HTML(200)이 돌아간다. 실제 production readback에서
 * `/api/internal/agents/*`와 `/api/internal/agent-adapter/*`가 401 JSON이 아니라
 * 200 text/html을 반환해 P6 agent queue 경계가 통째로 동작하지 않았다.
 */
test("자체 인증 API는 세션 미들웨어가 가로채지 않는다", () => {
  const selfAuthenticated = [
    ...routePaths("/api/internal"),
    ...routePaths("/api/admin"),
    ...routePaths("/api/control-plane"),
    "/api/webhooks",
    "/api/discord/interactions",
    "/api/health/live",
    "/api/health/ready",
    "/api/metrics",
  ];
  assert.ok(
    selfAuthenticated.some((path) => path.startsWith("/api/internal/agents/")),
    "agent queue route를 하나도 수집하지 못했다",
  );
  for (const path of selfAuthenticated) {
    assert.equal(
      sessionProtected(path),
      false,
      `${path}는 자체 인증 경계이므로 세션 미들웨어에서 제외돼야 한다`,
    );
  }
});

test("세션 보호 화면과 인증 경로 계약은 그대로 유지된다", () => {
  for (const path of ["/", "/board", "/issues", "/releases", "/settings", "/apps/abc/fleet"]) {
    assert.equal(sessionProtected(path), true, `${path}는 세션 보호 대상이어야 한다`);
  }
  for (const path of ["/login", "/api/auth/callback/github"]) {
    assert.equal(sessionProtected(path), false, `${path}는 로그인 경로라 보호 대상이 아니다`);
  }
});

/**
 * 제외 목록은 세그먼트 경계로 앵커돼야 한다. prefix만 맞는 경로가 함께 열리면
 * `/api/internal-tools` 같은 새 화면이 인증 없이 노출된다.
 */
test("제외 접두사는 세그먼트 경계로 앵커된다", () => {
  for (const path of [
    "/api/internalx",
    "/api/internal-tools",
    "/api/adminx",
    "/api/control-planex",
    "/api/discordx/interactions",
    "/loginx",
  ]) {
    assert.equal(sessionProtected(path), true, `${path}는 prefix 우회로 열리면 안 된다`);
  }
});
