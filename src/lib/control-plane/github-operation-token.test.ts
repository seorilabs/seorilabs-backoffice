import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GITHUB_READY_PR_TOKEN_PERMISSIONS,
  withScopedGithubReadyPrClient,
  type ScopedGithubTokenIssuer,
} from "@/lib/control-plane/github-operation-token";

interface FixtureClient {
  readonly marker: "scoped-client";
}

function issuer(input: {
  repoId?: number;
  repoFullName?: string;
  permissions?: Record<string, string>;
}) {
  const calls = {
    create: [] as unknown[],
    revoke: 0,
    read: 0,
    executed: 0,
  };
  const value: ScopedGithubTokenIssuer<FixtureClient> = {
    async createAccessToken(request) {
      calls.create.push(request);
      return {
        token: "fixture-token-is-never-returned",
        repositories: [{
          id: input.repoId ?? 123,
          fullName: input.repoFullName ?? "seorilabs/example",
        }],
        permissions: input.permissions ?? {
          ...GITHUB_READY_PR_TOKEN_PERMISSIONS,
          metadata: "read",
        },
      };
    },
    createClient() {
      return { marker: "scoped-client" };
    },
    async getRepository() {
      calls.read += 1;
      return {
        id: input.repoId ?? 123,
        fullName: input.repoFullName ?? "seorilabs/example",
      };
    },
    async revokeAccessToken() {
      calls.revoke += 1;
    },
  };
  return { calls, value };
}

test("GitHub operation token은 repository ID 하나와 최소 permission만 요청하고 readback 뒤 즉시 폐기한다", async () => {
  const fixture = issuer({});
  const result = await withScopedGithubReadyPrClient({
    issuer: fixture.value,
    installationId: 101,
    repoId: "123",
    repoFullName: "seorilabs/example",
    execute: async (client) => {
      fixture.calls.executed += 1;
      assert.equal(client.marker, "scoped-client");
      return "ok";
    },
  });
  assert.equal(result, "ok");
  assert.deepEqual(fixture.calls.create, [{
    installationId: 101,
    repositoryIds: [123],
    permissions: GITHUB_READY_PR_TOKEN_PERMISSIONS,
  }]);
  assert.equal(fixture.calls.read, 1);
  assert.equal(fixture.calls.executed, 1);
  assert.equal(fixture.calls.revoke, 1);
});

test("repository 또는 permission scope가 다르면 실행 전에 거부하고 token을 폐기한다", async () => {
  for (const fixture of [
    issuer({ repoId: 124 }),
    issuer({ repoFullName: "seorilabs/other" }),
    issuer({ permissions: { ...GITHUB_READY_PR_TOKEN_PERMISSIONS, administration: "write" } }),
  ]) {
    await assert.rejects(() => withScopedGithubReadyPrClient({
      issuer: fixture.value,
      installationId: 101,
      repoId: "123",
      repoFullName: "seorilabs/example",
      execute: async () => {
        fixture.calls.executed += 1;
      },
    }));
    assert.equal(fixture.calls.executed, 0);
    assert.equal(fixture.calls.revoke, 1);
  }
});

test("operation 또는 readback 실패에서도 token은 폐기된다", async () => {
  const fixture = issuer({});
  await assert.rejects(() => withScopedGithubReadyPrClient({
    issuer: fixture.value,
    installationId: 101,
    repoId: "123",
    repoFullName: "seorilabs/example",
    execute: async () => {
      throw new Error("fixture operation failed");
    },
  }), /fixture operation failed/u);
  assert.equal(fixture.calls.revoke, 1);
});

test("scoped client 생성 실패에서도 발급된 token은 폐기된다", async () => {
  const fixture = issuer({});
  fixture.value.createClient = () => {
    throw new Error("fixture client failed");
  };
  await assert.rejects(() => withScopedGithubReadyPrClient({
    issuer: fixture.value,
    installationId: 101,
    repoId: "123",
    repoFullName: "seorilabs/example",
    execute: async () => undefined,
  }), /fixture client failed/u);
  assert.equal(fixture.calls.revoke, 1);
});
