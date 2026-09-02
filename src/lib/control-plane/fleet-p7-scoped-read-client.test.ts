import assert from "node:assert/strict";
import test from "node:test";
import { createFleetP7RequestFetch, createFleetP7ScopedReadClient } from "@/lib/control-plane/fleet-p7-scoped-read-client";
import type { FleetScopedGithubTokenIssuer } from "@/lib/github/scoped-installation-client";
import type { FleetP7ReadClient } from "@/lib/control-plane/fleet-p7-github-readback";

const central = { repositoryId: "1241442018", fullName: "seorilabs/.github" };
const target = { repositoryId: "1250442131", fullName: "seorilabs/happy-farm" };
function fixture(input: { broader?: boolean; failure?: boolean; revokeFailure?: boolean } = {}) {
  const requests: Array<Record<string, unknown>> = [];
  let revoked = 0;
  const issuer: FleetScopedGithubTokenIssuer<FleetP7ReadClient> = {
    async createAccessToken(request) {
      requests.push({ ...request });
      const repository = request.repositoryIds[0] === Number(central.repositoryId) ? central : target;
      return { token: "fixture-only-read-token-no-live-credential", expiresAt: "2026-09-02T03:00:00.000Z",
        repositories: [{ id: Number(repository.repositoryId), fullName: repository.fullName }],
        permissions: input.broader ? { ...request.permissions, contents: "write" } : request.permissions };
    },
    createClient: () => ({ request: async (route, parameters) => {
      requests.push({ route, parameters });
      if (input.failure) throw new Error("provider failed");
      return { data: { state: "fixture" } };
    } }),
    revokeAccessToken: async () => { revoked += 1; if (input.revokeFailure) throw new Error("revoke failed"); },
  };
  return { requests, revoked: () => revoked, client: createFleetP7ScopedReadClient({
    issuer, installationId: "142120077", now: () => new Date("2026-09-02T02:30:00.000Z"),
  }) };
}

test("각 P7 조회는 한 repository와 필요한 read 권한만 대여하고 반환 전에 폐기한다", async () => {
  for (const [route, parameters, scope, permission] of [
    ["GET /repositories/{repository_id}", { repository_id: 1250442131 }, target, "contents"],
    ["GET /orgs/{org}", { org: "seorilabs" }, central, "organization_administration"],
    ["GET /orgs/{org}/properties/schema", { org: "seorilabs" }, central, "organization_custom_properties"],
    ["GET /repos/{owner}/{repo}/branches/{branch}/protection", { owner: "seorilabs", repo: "happy-farm", branch: "main" }, target, "administration"],
  ] as const) {
    const item = fixture();
    const result = await item.client.request(route, parameters, scope);
    assert.equal(item.revoked(), 1);
    assert.deepEqual(item.requests[0].repositoryIds, [Number(scope.repositoryId)]);
    const permissions = item.requests[0].permissions as Record<string, string>;
    assert.equal(permissions[permission], "read");
    assert.ok(Object.values(permissions).every((level) => level === "read"));
    assert.equal(Object.keys(permissions).length, 2);
    const actual = item.requests[1].parameters as Record<string, unknown>;
    assert.equal(actual.baseUrl, "https://api.github.com");
    assert.deepEqual(actual.headers, { "X-GitHub-Api-Version": "2026-03-10" });
    assert.equal((actual.request as { redirect: string }).redirect, "error");
    assert.doesNotMatch(JSON.stringify(result), /token|credential|authorization/iu);
  }
});

test("쓰기·다른 repository·임의 URL·파일·branch는 token 발급 전에 거부한다", async () => {
  for (const [route, parameters, scope] of [
    ["POST /orgs/{org}", { org: "seorilabs" }, central],
    ["GET /orgs/{org}", { org: "another" }, central],
    ["GET /repositories/{repository_id}", { repository_id: 999 }, target],
    ["GET /repositories/{repository_id}", { repository_id: 1250442131, url: "https://attacker.invalid", method: "POST" }, target],
    ["GET /repos/{owner}/{repo}/contents/{path}", { owner: "seorilabs", repo: "happy-farm", path: ".env", ref: "a".repeat(40) }, target],
    ["GET /repos/{owner}/{repo}/git/ref/{ref}", { owner: "seorilabs", repo: "other", ref: "heads/main" }, target],
  ] as const) {
    const item = fixture();
    await assert.rejects(item.client.request(route, parameters, scope), /FLEET_P7_READ_SCOPE_/u);
    assert.equal(item.requests.length, 0);
  }
});

test("과도한 token 권한·provider 실패에서도 폐기하고 폐기 실패는 성공으로 반환하지 않는다", async () => {
  for (const configuration of [{ broader: true }, { failure: true }, { revokeFailure: true }]) {
    const item = fixture(configuration);
    await assert.rejects(item.client.request("GET /repositories/{repository_id}", { repository_id: 1250442131 }, target));
    assert.equal(item.revoked(), 1);
  }
});

test("App JWT/token 교환도 exact API origin에 묶고 redirect와 무기한 요청을 금지한다", async () => {
  const calls: RequestInit[] = [];
  const transport: typeof globalThis.fetch = async (_input, init) => { calls.push(init ?? {}); return new Response("{}"); };
  const request = createFleetP7RequestFetch(transport);
  for (const url of ["https://api.github.com.attacker.invalid/app", "http://api.github.com/app", "https://user:password@api.github.com/app"]) {
    await assert.rejects(request(url), /FLEET_P7_API_ORIGIN_REJECTED/u);
  }
  assert.equal(calls.length, 0);
  await request("https://api.github.com/app/installations/142120077/access_tokens", { method: "POST", redirect: "follow" });
  assert.equal(calls[0].redirect, "error");
  assert.ok(calls[0].signal instanceof AbortSignal);
});
