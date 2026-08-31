import assert from "node:assert/strict";
import test from "node:test";

import { createFleetMigrationGitHubAdapter } from "@/lib/control-plane/fleet-migration-github-adapter";
import type { RepositoryInventoryClient } from "@/lib/control-plane/repository-discovery-backfill";
import type { FleetGitHubAppPublicSource } from "@/lib/github/app";

const SOURCE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const REPOSITORIES = [
  { id: 101, full_name: "seorilabs/alpha", default_branch: "main", archived: false, private: true, fork: false },
  { id: 202, full_name: "seorilabs/beta", default_branch: "main", archived: false, private: false, fork: false },
];

class FakeGitHub implements RepositoryInventoryClient {
  readonly pageRequests: number[] = [];

  async request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }> {
    if (route === "GET /installation/repositories") {
      const page = parameters.page as number;
      this.pageRequests.push(page);
      return { data: { total_count: 2, repositories: page === 1 ? [REPOSITORIES[0]] : page === 2 ? [REPOSITORIES[1]] : [] } };
    }
    if (route === "GET /repositories/{repository_id}") {
      return { data: REPOSITORIES.find(({ id }) => id === parameters.repository_id) };
    }
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      return { data: { object: { sha: SOURCE_SHA } } };
    }
    if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
      return { data: { tree: { sha: TREE_SHA } } };
    }
    if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
      return { data: { sha: TREE_SHA, truncated: false, tree: [
        { path: "README.md", mode: "100644", type: "blob", sha: BLOB_SHA, size: 5 },
      ] } };
    }
    if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}") {
      return { data: { sha: BLOB_SHA, size: 5, encoding: "base64", content: Buffer.from("hello").toString("base64") } };
    }
    throw new Error(`unexpected route: ${route}`);
  }
}

function publicSource(): FleetGitHubAppPublicSource {
  const permissions = { metadata: "read" as const };
  return {
    observedAt: "2026-08-30T00:00:00.000Z",
    app: {
      id: "4124446",
      slug: "seorilabs-backoffice",
      ownerId: "283115031",
      ownerLogin: "seorilabs",
      active: true,
      webhookActive: true,
      webhookUrl: "https://backoffice.vzyx.xyz/api/webhooks",
      permissions,
      events: ["repository"],
    },
    installation: {
      installationId: "142120077",
      appId: "4124446",
      targetId: "283115031",
      repositorySelection: "all",
      targetType: "Organization",
      accountLogin: "seorilabs",
      permissions,
      events: ["repository"],
      suspended: false,
      updatedAt: "2026-08-30T00:00:00.000Z",
      suspendedAt: null,
    },
  };
}

test("GitHub adapter completes provider pagination and keeps a stable public cursor snapshot", async () => {
  const client = new FakeGitHub();
  const adapter = createFleetMigrationGitHubAdapter({
    client,
    readAppSource: async () => publicSource(),
    readRepositoryWebhookAcceptance: async () => ({ deliveryId: "delivery-repository-0001", acceptedAt: new Date("2026-08-30T00:00:00.000Z") }),
    now: () => new Date("2026-08-30T00:00:01.000Z"),
  });
  const first = await adapter.readInstallationRepositoriesPage({
    contract: "seorilabs-github-installation-repositories-page-v1",
    organizationId: "283115031",
    organizationLogin: "seorilabs",
    installationId: "142120077",
    archived: false,
    pageSize: 1,
    cursor: null,
  });
  assert.deepEqual(client.pageRequests, [1, 2]);
  assert.equal(first.providerTotalCount, 2);
  assert.equal(first.repositories[0]?.fullName, "seorilabs/alpha");
  assert.equal(first.hasNextPage, true);

  const second = await adapter.readInstallationRepositoriesPage({
    contract: "seorilabs-github-installation-repositories-page-v1",
    organizationId: "283115031",
    organizationLogin: "seorilabs",
    installationId: "142120077",
    archived: false,
    pageSize: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.readbackId, first.readbackId);
  assert.equal(second.snapshotId, first.snapshotId);
  assert.equal(second.repositories[0]?.fullName, "seorilabs/beta");
  assert.equal(second.hasNextPage, false);
});

test("GitHub adapter reads exact HEAD, tree and canonical blob without exposing a token", async () => {
  const adapter = createFleetMigrationGitHubAdapter({
    client: new FakeGitHub(),
    readAppSource: async () => publicSource(),
    readRepositoryWebhookAcceptance: async () => ({ deliveryId: "delivery-repository-0001", acceptedAt: new Date("2026-08-30T00:00:00.000Z") }),
    now: () => new Date("2026-08-30T00:00:01.000Z"),
  });
  const capability = await adapter.readGitHubAppCapability({
    contract: "seorilabs-fleet-github-app-capability-v1",
    organizationId: "283115031",
    installationId: "142120077",
  });
  assert.doesNotMatch(JSON.stringify(capability), /token|privateKey|authorization/iu);
  const head = await adapter.readRepositoryHead({
    contract: "seorilabs-github-repository-head-readback-v1",
    repositoryId: "101",
    fullName: "seorilabs/alpha",
    defaultRef: "refs/heads/main",
  });
  assert.equal(head.sourceSha, SOURCE_SHA);
  assert.equal(head.treeSha, TREE_SHA);
  const tree = await adapter.readRepositoryTree({
    contract: "seorilabs-github-repository-tree-readback-v1",
    repositoryId: "101",
    fullName: "seorilabs/alpha",
    sourceSha: SOURCE_SHA,
    treeSha: TREE_SHA,
    recursive: true,
  });
  assert.equal(tree.entries[0]?.path, "README.md");
  const blob = await adapter.readBlob({
    contract: "seorilabs-github-repository-blob-readback-v1",
    repositoryId: "101",
    fullName: "seorilabs/alpha",
    sourceSha: SOURCE_SHA,
    treeSha: TREE_SHA,
    path: "README.md",
    objectSha: BLOB_SHA,
  });
  assert.equal(Buffer.from(blob.content, "base64").toString("utf8"), "hello");
});

test("GitHub adapter rejects unsafe tree entries and non-canonical blob encodings", async () => {
  class UnsafeGitHub extends FakeGitHub {
    override async request(route: string, parameters: Record<string, unknown>) {
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        return { data: { sha: TREE_SHA, truncated: false, tree: [
          { path: "../secret", mode: "120000", type: "blob", sha: BLOB_SHA, size: 5 },
        ] } };
      }
      return super.request(route, parameters);
    }
  }
  const adapter = createFleetMigrationGitHubAdapter({
    client: new UnsafeGitHub(),
    readAppSource: async () => publicSource(),
    readRepositoryWebhookAcceptance: async () => null,
  });
  await assert.rejects(adapter.readRepositoryTree({
    contract: "seorilabs-github-repository-tree-readback-v1",
    repositoryId: "101",
    fullName: "seorilabs/alpha",
    sourceSha: SOURCE_SHA,
    treeSha: TREE_SHA,
    recursive: true,
  }), /FLEET_MIGRATION_GITHUB_TREE_INVALID/);
});
