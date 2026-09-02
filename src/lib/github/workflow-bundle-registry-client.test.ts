import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import { withWorkflowBundleRegistryReadClient } from "@/lib/github/workflow-bundle-registry-client";

test("중앙 후보 조회는 Actions read scope만 대여하고 성공/실패 모두 revoke한다", async () => {
  for (const fail of [false, true]) {
    let revoked = 0;
    const read = withWorkflowBundleRegistryReadClient(async () => {
      if (fail) throw new Error("signed-url=CANARY_SECRET");
      return { runId: "123" };
    }, async () => ({
      installationId: "142120077",
      issuer: {
        async createAccessToken(input) {
          assert.deepEqual(input, { installationId: 142120077, repositoryIds: [1241442018], permissions: { actions: "read", metadata: "read" } });
          return { token: "fixture-candidate-read-token", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            permissions: input.permissions, repositories: [{ id: 1241442018, fullName: "seorilabs/.github" }] };
        },
        createClient() { return {} as never; },
        async revokeAccessToken() { revoked += 1; },
      },
    }));
    if (fail) await assert.rejects(read, { message: "WORKFLOW_BUNDLE_CANDIDATE_GITHUB_READ_FAILED" });
    else assert.deepEqual(await read, { runId: "123" });
    assert.equal(revoked, 1);
  }
});

test("revoke/issuer 오류의 header와 cause는 API/logger 경계까지 전달하지 않는다", async () => {
  for (const failIssuer of [false, true]) {
    await assert.rejects(withWorkflowBundleRegistryReadClient(async () => undefined, async () => {
      if (failIssuer) throw new Error("CANARY_SECRET issuer");
      return { installationId: "142120077", issuer: {
        async createAccessToken() {
          return { token: "fixture-candidate-read-token", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            permissions: { actions: "read", metadata: "read" }, repositories: [{ id: 1241442018, fullName: "seorilabs/.github" }] };
        },
        createClient() { return {} as never; },
        async revokeAccessToken() { throw new Error("CANARY_SECRET Authorization header"); },
      } };
    }), (error) => {
      assert.doesNotMatch(inspect(error, { depth: 10 }), /CANARY_SECRET|fixture-candidate-read-token/);
      assert.match((error as Error).message, /^(?:FLEET_GITHUB_TOKEN_REVOKE_FAILED|WORKFLOW_BUNDLE_CANDIDATE_GITHUB_READ_FAILED)$/);
      return true;
    });
  }
});
