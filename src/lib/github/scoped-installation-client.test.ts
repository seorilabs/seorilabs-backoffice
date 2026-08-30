import assert from "node:assert/strict";
import test from "node:test";

import {
  FLEET_GITHUB_CAPABILITY_PERMISSIONS,
  withFleetScopedGithubClient,
  type FleetScopedGithubTokenIssuer,
} from "@/lib/github/scoped-installation-client";

interface FixtureClient {
  marker: "fixture";
}

function fixtureIssuer(input: {
  repositoryId?: number;
  repositoryFullName?: string;
  permissions?: Record<string, string>;
  createClientFailure?: boolean;
}) {
  const calls = {
    create: [] as unknown[],
    execute: 0,
    revoke: 0,
  };
  const issuer: FleetScopedGithubTokenIssuer<FixtureClient> = {
    async createAccessToken(request) {
      calls.create.push(request);
      return {
        token: "fixture-token-never-leaves-callback",
        expiresAt: "2026-08-30T01:30:00.000Z",
        permissions: input.permissions ?? request.permissions,
        repositories: [{
          id: input.repositoryId ?? 123,
          fullName: input.repositoryFullName ?? "seorilabs/example",
        }],
      };
    },
    createClient() {
      if (input.createClientFailure) throw new Error("fixture client failure");
      return { marker: "fixture" };
    },
    async revokeAccessToken() {
      calls.revoke += 1;
    },
  };
  return { calls, issuer };
}

test("표준 label write token은 대상 repository 하나와 exact issues:write만 사용하고 즉시 폐기한다", async () => {
  const fixture = fixtureIssuer({});
  const result = await withFleetScopedGithubClient({
    issuer: fixture.issuer,
    installationId: "99",
    capability: "github.standard-labels.ensure",
    repositoryId: "123",
    repositoryFullName: "seorilabs/example",
    now: new Date("2026-08-30T01:00:00.000Z"),
    execute: async (client) => {
      fixture.calls.execute += 1;
      assert.equal(client.marker, "fixture");
      return { state: "MATCH" };
    },
  });
  assert.deepEqual(result, { state: "MATCH" });
  assert.deepEqual(fixture.calls.create, [{
    installationId: 99,
    repositoryIds: [123],
    permissions: FLEET_GITHUB_CAPABILITY_PERMISSIONS["github.standard-labels.ensure"],
  }]);
  assert.equal(fixture.calls.execute, 1);
  assert.equal(fixture.calls.revoke, 1);
  assert.doesNotMatch(JSON.stringify(result), /token|authorization|capability/i);
});

test("계약 source와 readback capability는 write permission을 가질 수 없다", async () => {
  for (const capability of [
    "github.standard-labels.contract.read",
    "github.standard-labels.read",
  ] as const) {
    const fixture = fixtureIssuer({});
    await withFleetScopedGithubClient({
      issuer: fixture.issuer,
      installationId: "99",
      capability,
      repositoryId: "123",
      repositoryFullName: "seorilabs/example",
      now: new Date("2026-08-30T01:00:00.000Z"),
      execute: async () => undefined,
    });
    const request = fixture.calls.create[0] as { permissions: Record<string, string> };
    assert.equal(Object.values(request.permissions).includes("write"), false);
    assert.equal(fixture.calls.revoke, 1);
  }
});

test("repository나 permission scope가 넓으면 callback 전에 거부하고 token을 폐기한다", async () => {
  for (const fixture of [
    fixtureIssuer({ repositoryId: 124 }),
    fixtureIssuer({ repositoryFullName: "seorilabs/other" }),
    fixtureIssuer({ permissions: { issues: "write", metadata: "read", contents: "write" } }),
  ]) {
    await assert.rejects(() => withFleetScopedGithubClient({
      issuer: fixture.issuer,
      installationId: "99",
      capability: "github.standard-labels.ensure",
      repositoryId: "123",
      repositoryFullName: "seorilabs/example",
      now: new Date("2026-08-30T01:00:00.000Z"),
      execute: async () => {
        fixture.calls.execute += 1;
      },
    }), /FLEET_GITHUB_TOKEN_(?:SCOPE|PERMISSION)_MISMATCH/u);
    assert.equal(fixture.calls.execute, 0);
    assert.equal(fixture.calls.revoke, 1);
  }
});

test("client 생성 또는 provider operation 실패에서도 발급 token을 폐기한다", async () => {
  const createFailure = fixtureIssuer({ createClientFailure: true });
  await assert.rejects(() => withFleetScopedGithubClient({
    issuer: createFailure.issuer,
    installationId: "99",
    capability: "github.standard-labels.ensure",
    repositoryId: "123",
    repositoryFullName: "seorilabs/example",
    now: new Date("2026-08-30T01:00:00.000Z"),
    execute: async () => undefined,
  }), /fixture client failure/u);
  assert.equal(createFailure.calls.revoke, 1);

  const operationFailure = fixtureIssuer({});
  await assert.rejects(() => withFleetScopedGithubClient({
    issuer: operationFailure.issuer,
    installationId: "99",
    capability: "github.standard-labels.ensure",
    repositoryId: "123",
    repositoryFullName: "seorilabs/example",
    now: new Date("2026-08-30T01:00:00.000Z"),
    execute: async () => {
      throw new Error("fixture operation failure");
    },
  }), /fixture operation failure/u);
  assert.equal(operationFailure.calls.revoke, 1);
});
