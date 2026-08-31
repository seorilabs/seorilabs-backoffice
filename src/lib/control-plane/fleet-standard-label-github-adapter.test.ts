import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Octokit } from "octokit";

import {
  createFleetStandardLabelGithubAdapter,
} from "@/lib/control-plane/fleet-standard-label-github-adapter";
import {
  fleetStandardLabelOperation,
  type FleetRepositoryLabel,
} from "@/lib/control-plane/fleet-standard-labels";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  FLEET_GITHUB_CAPABILITY_PERMISSIONS,
  type FleetScopedGithubTokenIssuer,
} from "@/lib/github/scoped-installation-client";

const catalog = {
  schemaVersion: 1 as const,
  catalogVersion: "fixture-standard-labels/v1",
  strategy: "UPSERT_FIXED_PRESERVE_CUSTOM" as const,
  labels: [
    { name: "P1", color: "B60205", description: "최우선" },
    { name: "autopilot", color: "EDEDED", description: "자동 처리" },
  ],
};
const catalogDigest = `sha256:${jsonDigest(catalog as unknown as JsonValue)}`;
const config = {
  repositoryId: "1",
  repositoryFullName: "seorilabs/.github" as const,
  sourceSha: "a".repeat(40),
  catalogPath: "contracts/fleet-standard-labels.json" as const,
  catalogBlobSha: "b".repeat(40),
  expectedCatalogDigest: catalogDigest,
  packageExport: "@seorilabs/repo-contract/standard-labels" as const,
};

function fixture() {
  let labels: FleetRepositoryLabel[] = [
    { name: "P1", color: "FFFFFF", description: "wrong" },
    { name: "custom", color: "ABCDEF", description: "보존" },
  ];
  const calls = {
    tokenRequests: [] as Array<{ repositoryIds: readonly number[]; permissions: Record<string, string> }>,
    revocations: 0,
    creates: 0,
    updates: 0,
  };
  const client = {
    rest: {
      repos: {
        async get({ owner, repo }: { owner: string; repo: string }) {
          const fullName = `${owner}/${repo}`;
          return { data: {
            id: fullName === "seorilabs/.github" ? 1 : 2,
            full_name: fullName,
            archived: false,
            private: fullName !== "seorilabs/.github",
          } };
        },
        async getContent() {
          return { data: {
            type: "file",
            sha: config.catalogBlobSha,
            encoding: "base64",
            content: Buffer.from(JSON.stringify(catalog), "utf8").toString("base64"),
          } };
        },
      },
      issues: {
        async listLabelsForRepo({ page }: { page: number }) {
          return { data: page === 1
            ? labels.map((label, index) => ({ ...label, id: index + 1, description: label.description }))
            : [] };
        },
        async createLabel(input: { name: string; color: string; description?: string }) {
          calls.creates += 1;
          labels.push({ name: input.name, color: input.color, description: input.description ?? "" });
          return { data: labels.at(-1) };
        },
        async updateLabel(input: { name: string; new_name?: string; color?: string; description?: string }) {
          calls.updates += 1;
          labels = labels.map((label) => label.name === input.name ? {
            name: input.new_name ?? label.name,
            color: input.color ?? label.color,
            description: input.description ?? label.description,
          } : label);
          return { data: labels.find((label) => label.name === (input.new_name ?? input.name)) };
        },
      },
    },
  } as unknown as Octokit;
  const issuer: FleetScopedGithubTokenIssuer<Octokit> = {
    async createAccessToken(input) {
      calls.tokenRequests.push({
        repositoryIds: input.repositoryIds,
        permissions: { ...input.permissions },
      });
      const repositoryId = input.repositoryIds[0];
      return {
        token: `fixture-scoped-installation-token-${calls.tokenRequests.length}`,
        expiresAt: "2026-08-30T01:30:00.000Z",
        permissions: input.permissions,
        repositories: [{
          id: repositoryId,
          fullName: repositoryId === 1 ? "seorilabs/.github" : "seorilabs/example",
        }],
      };
    },
    createClient() {
      return client;
    },
    async revokeAccessToken() {
      calls.revocations += 1;
    },
  };
  return { calls, issuer, labels: () => structuredClone(labels) };
}

test("adapter는 exact 중앙 catalog BLOB을 읽고 대상 repository read token을 분리한다", async () => {
  const state = fixture();
  const adapter = createFleetStandardLabelGithubAdapter({
    getIssuer: async () => ({ installationId: "99", issuer: state.issuer }),
    now: () => new Date("2026-08-30T01:00:00.000Z"),
  });
  const contract = await adapter.readContract(config);
  const operation = fleetStandardLabelOperation({
    contract,
    repositoryId: "2",
    repositoryFullName: "seorilabs/example",
  });
  const readback = await adapter.readRepository({
    repositoryId: "2",
    repositoryFullName: "seorilabs/example",
    operation,
  });
  assert.equal(readback.identity.private, true);
  assert.equal(readback.observation.state, "DRIFT");
  assert.deepEqual(state.calls.tokenRequests, [
    { repositoryIds: [1], permissions: FLEET_GITHUB_CAPABILITY_PERMISSIONS["github.standard-labels.contract.read"] },
    { repositoryIds: [2], permissions: FLEET_GITHUB_CAPABILITY_PERMISSIONS["github.standard-labels.read"] },
  ]);
  assert.equal(state.calls.revocations, 2);
});

test("adapter는 fixed label만 upsert하고 custom label을 exact 보존한 뒤 readback한다", async () => {
  const state = fixture();
  const adapter = createFleetStandardLabelGithubAdapter({
    getIssuer: async () => ({ installationId: "99", issuer: state.issuer }),
    now: () => new Date("2026-08-30T01:00:00.000Z"),
  });
  const contract = await adapter.readContract(config);
  const operation = fleetStandardLabelOperation({
    contract,
    repositoryId: "2",
    repositoryFullName: "seorilabs/example",
  });
  let leaseChecks = 0;
  const receipt = await adapter.ensureRepository({
    repositoryId: "2",
    repositoryFullName: "seorilabs/example",
    operation,
    assertLease: async () => {
      leaseChecks += 1;
    },
  });
  assert.equal(receipt.state, "UPDATED");
  assert.equal(receipt.mutations, 2);
  assert.equal(state.calls.creates, 1);
  assert.equal(state.calls.updates, 1);
  assert.equal(leaseChecks, 3);
  assert.deepEqual(state.labels(), [
    { name: "P1", color: "B60205", description: "최우선" },
    { name: "custom", color: "ABCDEF", description: "보존" },
    { name: "autopilot", color: "EDEDED", description: "자동 처리" },
  ]);
  assert.deepEqual(state.calls.tokenRequests.at(-1), {
    repositoryIds: [2],
    permissions: FLEET_GITHUB_CAPABILITY_PERMISSIONS["github.standard-labels.ensure"],
  });
  assert.equal(state.calls.revocations, 2);
  assert.doesNotMatch(JSON.stringify(receipt), /token|authorization|lease/i);
});

test("label adapter surface에는 delete나 다른 GitHub mutation capability가 없다", () => {
  const source = readFileSync(join(
    process.cwd(),
    "src/lib/control-plane/fleet-standard-label-github-adapter.ts",
  ), "utf8");
  assert.doesNotMatch(source, /deleteLabel|pulls\.|repos\.update|createWorkflowDispatch|createOrUpdate.*Secret|permission|role|release/iu);
  assert.match(source, /issues\.createLabel/);
  assert.match(source, /issues\.updateLabel/);
});
