import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  FLEET_GITHUB_CAPABILITY_PERMISSIONS,
  issueFleetMigrationGithubCapabilityToSink,
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
  revokeFailure?: boolean;
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
      if (input.revokeFailure) throw new Error("fixture revoke failure");
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
    now: () => new Date("2026-08-30T01:00:00.000Z"),
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
    "github.workflow-bundle-candidate.read",
  ] as const) {
    const fixture = fixtureIssuer({});
    await withFleetScopedGithubClient({
      issuer: fixture.issuer,
      installationId: "99",
      capability,
      repositoryId: "123",
      repositoryFullName: "seorilabs/example",
      now: () => new Date("2026-08-30T01:00:00.000Z"),
      execute: async () => undefined,
    });
    const request = fixture.calls.create[0] as { permissions: Record<string, string> };
    assert.equal(Object.values(request.permissions).includes("write"), false);
    assert.equal(fixture.calls.revoke, 1);
  }
});

test("WorkflowBundle candidate token은 한 repository와 caller PR 최소 permission만 대여한다", async () => {
  const fixture = fixtureIssuer({});
  await withFleetScopedGithubClient({
    issuer: fixture.issuer,
    installationId: "99",
    capability: "github.workflow-bundle-candidate.ready-pr",
    repositoryId: "123",
    repositoryFullName: "seorilabs/example",
    now: () => new Date("2026-08-30T01:00:00.000Z"),
    execute: async () => undefined,
  });
  assert.deepEqual(fixture.calls.create, [{
    installationId: 99,
    repositoryIds: [123],
    permissions: {
      contents: "write",
      issues: "read",
      metadata: "read",
      pull_requests: "write",
      workflows: "write",
    },
  }]);
  assert.equal(fixture.calls.revoke, 1);
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
      now: () => new Date("2026-08-30T01:00:00.000Z"),
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
    now: () => new Date("2026-08-30T01:00:00.000Z"),
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
    now: () => new Date("2026-08-30T01:00:00.000Z"),
    execute: async () => {
      throw new Error("fixture operation failure");
    },
  }), /fixture operation failure/u);
  assert.equal(operationFailure.calls.revoke, 1);
});

test("operation 실패와 revoke 실패가 겹쳐도 token 폐기 실패를 fail-closed한다", async () => {
  const fixture = fixtureIssuer({ revokeFailure: true });
  await assert.rejects(() => withFleetScopedGithubClient({
    issuer: fixture.issuer,
    installationId: "99",
    capability: "github.standard-labels.ensure",
    repositoryId: "123",
    repositoryFullName: "seorilabs/example",
    now: () => new Date("2026-08-30T01:00:00.000Z"),
    execute: async () => {
      throw new Error("fixture operation failure");
    },
  }), /FLEET_GITHUB_TOKEN_REVOKE_FAILED/u);
  assert.equal(fixture.calls.revoke, 1);
});

test("migration issuer는 exact multi-repository read capability를 sink에만 전달한다", async () => {
  const token = "fixture-migration-token-never-returned";
  const calls = {
    create: [] as unknown[],
    deliver: 0,
    revoke: 0,
  };
  const issuer: FleetScopedGithubTokenIssuer<FixtureClient> = {
    async createAccessToken(request) {
      calls.create.push(request);
      return {
        token,
        expiresAt: "2026-08-30T01:30:00.000Z",
        permissions: request.permissions,
        // provider 순서와 무관하게 exact set을 검증해야 한다.
        repositories: [
          { id: 456, fullName: "seorilabs/other" },
          { id: 123, fullName: "seorilabs/example" },
        ],
      };
    },
    createClient() {
      return { marker: "fixture" };
    },
    async revokeAccessToken() {
      calls.revoke += 1;
    },
  };
  const receipt = await issueFleetMigrationGithubCapabilityToSink({
    issuer,
    installationId: "99",
    executionId: "migration-shadow-run-1",
    repositories: [
      { id: "456", fullName: "seorilabs/other" },
      { id: "123", fullName: "seorilabs/example" },
    ],
    now: () => new Date("2026-08-30T01:00:00.000Z"),
    deliver: async (delivery) => {
      calls.deliver += 1;
      assert.equal(delivery.token, token);
      assert.equal(delivery.receipt.executionId, "migration-shadow-run-1");
    },
  });
  assert.deepEqual(calls.create, [{
    installationId: 99,
    repositoryIds: [123, 456],
    permissions: FLEET_GITHUB_CAPABILITY_PERMISSIONS["github.fleet-migration.shadow-read"],
  }]);
  assert.equal(calls.deliver, 1);
  assert.equal(calls.revoke, 0, "accepted one-run token은 runtime terminal에서 폐기한다");
  assert.equal(receipt.tokenSha256, createHash("sha256").update(token).digest("hex"));
  assert.deepEqual(receipt.repositories, [
    { id: "123", fullName: "seorilabs/example" },
    { id: "456", fullName: "seorilabs/other" },
  ]);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(token, "u"));
});

test("migration token의 cohort, permission, sink가 다르면 handoff 전에 폐기한다", async () => {
  const cases = [
    {
      repositories: [
        { id: 123, fullName: "seorilabs/example" },
        { id: 999, fullName: "seorilabs/unapproved" },
      ],
      permissions: { contents: "read", metadata: "read" },
      deliveryFailure: false,
    },
    {
      repositories: [
        { id: 123, fullName: "seorilabs/example" },
        { id: 456, fullName: "seorilabs/other" },
      ],
      permissions: { contents: "write", metadata: "read" },
      deliveryFailure: false,
    },
    {
      repositories: [
        { id: 123, fullName: "seorilabs/example" },
        { id: 456, fullName: "seorilabs/other" },
      ],
      permissions: { contents: "read", metadata: "read" },
      deliveryFailure: true,
    },
  ];
  for (const fixture of cases) {
    let delivered = 0;
    let revoked = 0;
    const issuer: FleetScopedGithubTokenIssuer<FixtureClient> = {
      async createAccessToken() {
        return {
          token: "fixture-migration-token-never-returned",
          expiresAt: "2026-08-30T01:30:00.000Z",
          permissions: fixture.permissions,
          repositories: fixture.repositories,
        };
      },
      createClient() {
        return { marker: "fixture" };
      },
      async revokeAccessToken() {
        revoked += 1;
      },
    };
    await assert.rejects(() => issueFleetMigrationGithubCapabilityToSink({
      issuer,
      installationId: "99",
      executionId: "migration-shadow-run-1",
      repositories: [
        { id: "123", fullName: "seorilabs/example" },
        { id: "456", fullName: "seorilabs/other" },
      ],
      now: () => new Date("2026-08-30T01:00:00.000Z"),
      deliver: async () => {
        delivered += 1;
        if (fixture.deliveryFailure) throw new Error("fixture sink failure");
      },
    }), /FLEET_GITHUB_TOKEN_(?:SCOPE|PERMISSION)_MISMATCH|fixture sink failure/u);
    assert.equal(delivered, fixture.deliveryFailure ? 1 : 0);
    assert.equal(revoked, 1);
  }
});
