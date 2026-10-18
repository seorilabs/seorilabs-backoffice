import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { getFleetScopedGithubTokenIssuer } from "@/lib/github/app";
test("등록 POST는 공급자 500 응답에도 SDK가 자동 재전송하지 않는다", async () => {
  const previous = { app: process.env.GITHUB_APP_ID, key: process.env.GITHUB_PRIVATE_KEY, org: process.env.GITHUB_ORG };
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GITHUB_APP_ID = "123"; process.env.GITHUB_PRIVATE_KEY = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(); process.env.GITHUB_ORG = "seorilabs";
  let posts = 0;
  try {
    const { issuer } = await getFleetScopedGithubTokenIssuer({ disableAutomaticRetries: true, requestFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/orgs/seorilabs/installation")) return new Response(JSON.stringify({ id: 99, app_id: 123, target_id: 77, permissions: { issues: "write", contents: "read", metadata: "read", pull_requests: "read" }, events: [], account: { id: 77, login: "seorilabs", type: "Organization" }, target_type: "Organization", repository_selection: "all", suspended_at: null }), { status: 200, headers: { "content-type": "application/json" } });
      if (init?.method === "POST") posts++;
      return new Response(JSON.stringify({ message: "fixture failure" }), { status: 500, headers: { "content-type": "application/json" } });
    }) as typeof fetch });
    await assert.rejects(issuer.createClient("fixture-only-token").request("POST /repos/seorilabs/example/issues", { title: "격리 검증" }));
    assert.equal(posts, 1);
  } finally {
    for (const [key, value] of [["GITHUB_APP_ID", previous.app], ["GITHUB_PRIVATE_KEY", previous.key], ["GITHUB_ORG", previous.org]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
  }
});
