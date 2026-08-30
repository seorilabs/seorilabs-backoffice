import { Buffer } from "node:buffer";

import { computeFleetEvidenceDigest } from "@seorilabs/repo-contract/fleet-migration";

import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import type { RepositoryInventoryClient } from "@/lib/control-plane/repository-discovery-backfill";
import type { FleetGitHubAppPublicSource } from "@/lib/github/app";

const ORGANIZATION_ID = "283115031";
const ORGANIZATION_LOGIN = "seorilabs";
const INSTALLATION_ID = "142120077";
const CAPABILITY_CONTRACT = "seorilabs-fleet-github-app-capability-v1";
const PAGE_CONTRACT = "seorilabs-github-installation-repositories-page-v1";
const HEAD_CONTRACT = "seorilabs-github-repository-head-readback-v1";
const TREE_CONTRACT = "seorilabs-github-repository-tree-readback-v1";
const BLOB_CONTRACT = "seorilabs-github-repository-blob-readback-v1";
const HANDLER_REVISION = "fleet-migration-bootstrap-shadow-v1";
const SHA = /^[0-9a-f]{40}$/u;
const GIT_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[^\u0000-\u001f\u007f]{1,4096}$/u;
const CURSOR = /^fleet-page-([0-9a-f]{24})-([1-9][0-9]{0,5})$/u;
const MAX_PROVIDER_PAGES = 1000;

interface GitHubRepository {
  id: number;
  fullName: string;
  defaultBranch: string;
  archived: boolean;
  private: boolean;
  fork: boolean;
}

interface RepositorySnapshot {
  key: string;
  readbackId: string;
  snapshotId: string;
  observedAt: string;
  repositories: GitHubRepository[];
}

export interface FleetMigrationWebhookAcceptance {
  deliveryId: string;
  acceptedAt: Date;
}

export interface FleetMigrationGitHubAdapterDependencies {
  client: RepositoryInventoryClient;
  readAppSource: () => Promise<FleetGitHubAppPublicSource>;
  readRepositoryWebhookAcceptance: () => Promise<FleetMigrationWebhookAcceptance | null>;
  now?: () => Date;
}

function fail(code: string): never {
  throw new Error(code);
}

function evidence<T extends Record<string, unknown>>(value: T): T & { evidenceDigest: string } {
  const result = { ...value, evidenceDigest: `sha256:${"0".repeat(64)}` };
  result.evidenceDigest = computeFleetEvidenceDigest(result);
  return result;
}

function evidenceId(prefix: string, value: unknown): string {
  return `${prefix}-${jsonDigest(value as JsonValue).slice(0, 32)}`;
}

function permissionVector(value: Record<string, "read" | "write" | "admin">) {
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, access]) => ({ name, access }));
}

function exactRepository(value: unknown): GitHubRepository {
  const repository = value as {
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
    archived?: unknown;
    private?: unknown;
    fork?: unknown;
  } | null;
  if (
    typeof repository?.id !== "number"
    || !Number.isSafeInteger(repository.id)
    || repository.id < 1
    || typeof repository.full_name !== "string"
    || !/^seorilabs\/[A-Za-z0-9._-]+$/u.test(repository.full_name)
    || typeof repository.default_branch !== "string"
    || repository.default_branch.length < 1
    || repository.default_branch.length > 128
    || typeof repository.archived !== "boolean"
    || typeof repository.private !== "boolean"
    || typeof repository.fork !== "boolean"
  ) fail("FLEET_MIGRATION_GITHUB_REPOSITORY_INVALID");
  return {
    id: repository.id,
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    archived: repository.archived,
    private: repository.private,
    fork: repository.fork,
  };
}

function sameRepository(left: GitHubRepository, right: GitHubRepository): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createFleetMigrationGitHubAdapter(
  dependencies: FleetMigrationGitHubAdapterDependencies,
) {
  const pageSnapshots = new Map<string, RepositorySnapshot>();
  let currentSnapshot: RepositorySnapshot | null = null;
  let readbackSequence = 0;
  let lastObservedAt = 0;
  const trustedNow = (): string => {
    const observed = dependencies.now?.() ?? new Date();
    const time = observed.getTime();
    if (!Number.isFinite(time)) fail("FLEET_MIGRATION_GITHUB_TIME_INVALID");
    lastObservedAt = Math.max(time, lastObservedAt);
    return new Date(lastObservedAt).toISOString();
  };
  const nextReadbackId = (prefix: string, binding: unknown, observedAt: string): string => {
    readbackSequence += 1;
    return evidenceId(prefix, { binding, readbackSequence, observedAt });
  };

  async function loadRepositorySnapshot(): Promise<RepositorySnapshot> {
    const all: GitHubRepository[] = [];
    let providerTotal: number | null = null;
    for (let page = 1; page <= MAX_PROVIDER_PAGES; page += 1) {
      const response = await dependencies.client.request("GET /installation/repositories", {
        per_page: 100,
        page,
      });
      const data = response.data as { total_count?: unknown; repositories?: unknown } | null;
      if (
        typeof data?.total_count !== "number"
        || !Number.isSafeInteger(data.total_count)
        || data.total_count < 1
        || !Array.isArray(data.repositories)
      ) fail("FLEET_MIGRATION_GITHUB_PAGINATION_INVALID");
      providerTotal ??= data.total_count;
      if (providerTotal !== data.total_count) fail("FLEET_MIGRATION_GITHUB_PAGINATION_DRIFT");
      all.push(...data.repositories.map(exactRepository));
      if (all.length > providerTotal) fail("FLEET_MIGRATION_GITHUB_PAGINATION_INVALID");
      if (all.length === providerTotal) break;
      if (data.repositories.length === 0) fail("FLEET_MIGRATION_GITHUB_PAGINATION_INCOMPLETE");
    }
    if (providerTotal === null || all.length !== providerTotal) {
      fail("FLEET_MIGRATION_GITHUB_PAGINATION_INCOMPLETE");
    }
    const active = all.filter(({ archived }) => !archived)
      .sort((left, right) => left.id - right.id);
    if (
      active.length < 1
      || new Set(active.map(({ id }) => id)).size !== active.length
      || new Set(active.map(({ fullName }) => fullName.toLowerCase())).size !== active.length
    ) fail("FLEET_MIGRATION_GITHUB_PAGINATION_INVALID");
    const observedAt = trustedNow();
    const key = jsonDigest(active as unknown as JsonValue).slice(0, 24);
    const snapshot = {
      key,
      readbackId: evidenceId("github-installation-page-readback", { key, observedAt }),
      snapshotId: evidenceId("github-installation-page-snapshot", { key, observedAt }),
      observedAt,
      repositories: active,
    };
    pageSnapshots.set(key, snapshot);
    currentSnapshot = snapshot;
    return snapshot;
  }

  async function readExactRepository(repositoryId: string, fullName: string): Promise<GitHubRepository> {
    const numericId = Number(repositoryId);
    if (!Number.isSafeInteger(numericId) || numericId < 1) {
      fail("FLEET_MIGRATION_GITHUB_REPOSITORY_INVALID");
    }
    const response = await dependencies.client.request("GET /repositories/{repository_id}", {
      repository_id: numericId,
    });
    const repository = exactRepository(response.data);
    if (repository.id !== numericId || repository.fullName !== fullName || repository.archived) {
      fail("FLEET_MIGRATION_GITHUB_REPOSITORY_DRIFT");
    }
    return repository;
  }

  return Object.freeze({
    async readGitHubAppCapability(request: Record<string, unknown>) {
      if (
        request.contract !== CAPABILITY_CONTRACT
        || request.organizationId !== ORGANIZATION_ID
        || request.installationId !== INSTALLATION_ID
      ) fail("FLEET_MIGRATION_GITHUB_CAPABILITY_REQUEST_INVALID");
      const [source, acceptance] = await Promise.all([
        dependencies.readAppSource(),
        dependencies.readRepositoryWebhookAcceptance(),
      ]);
      const observedAt = trustedNow();
      const appReadbackId = nextReadbackId("github-app-readback", source.app, observedAt);
      const installationReadbackId = nextReadbackId("github-installation-readback", source.installation, observedAt);
      const eventAcceptance = evidence({
        state: acceptance ? "ACCEPTED" : "UNVERIFIED",
        event: "repository",
        deliveryId: acceptance?.deliveryId ?? null,
        acceptedAt: acceptance?.acceptedAt.toISOString() ?? null,
        handlerRevision: acceptance ? HANDLER_REVISION : null,
        appReadbackId,
        installationReadbackId,
      });
      return evidence({
        contract: CAPABILITY_CONTRACT,
        revision: nextReadbackId("github-capability-revision", { appReadbackId }, observedAt),
        observedAt,
        organization: { id: ORGANIZATION_ID, login: ORGANIZATION_LOGIN },
        app: {
          readbackId: appReadbackId,
          id: source.app.id,
          slug: source.app.slug,
          ownerId: source.app.ownerId,
          ownerLogin: source.app.ownerLogin,
          active: source.app.active,
          webhookActive: source.app.webhookActive,
          webhookUrl: source.app.webhookUrl,
          permissions: permissionVector(source.app.permissions),
          events: [...source.app.events].sort(),
        },
        installation: {
          readbackId: installationReadbackId,
          id: source.installation.installationId,
          appId: source.installation.appId,
          accountId: source.installation.targetId,
          accountLogin: source.installation.accountLogin,
          targetType: source.installation.targetType,
          repositorySelection: source.installation.repositorySelection,
          suspendedAt: source.installation.suspendedAt,
          updatedAt: source.installation.updatedAt,
          permissions: permissionVector(source.installation.permissions),
        },
        eventAcceptance,
      });
    },

    async readInstallationRepositoriesPage(request: Record<string, unknown>) {
      if (
        request.contract !== PAGE_CONTRACT
        || request.organizationId !== ORGANIZATION_ID
        || request.organizationLogin !== ORGANIZATION_LOGIN
        || request.installationId !== INSTALLATION_ID
        || request.archived !== false
        || !Number.isSafeInteger(request.pageSize)
        || (request.pageSize as number) < 1
        || (request.pageSize as number) > 100
      ) fail("FLEET_MIGRATION_GITHUB_PAGE_REQUEST_INVALID");
      const pageSize = request.pageSize as number;
      const requestCursor = request.cursor;
      let snapshot: RepositorySnapshot;
      let offset = 0;
      if (requestCursor === null) {
        snapshot = await loadRepositorySnapshot();
      } else {
        const match = typeof requestCursor === "string" ? CURSOR.exec(requestCursor) : null;
        if (!match) fail("FLEET_MIGRATION_GITHUB_CURSOR_INVALID");
        snapshot = pageSnapshots.get(match[1]) ?? fail("FLEET_MIGRATION_GITHUB_CURSOR_EXPIRED");
        offset = Number(match[2]);
      }
      if (snapshot !== currentSnapshot || offset >= snapshot.repositories.length) {
        fail("FLEET_MIGRATION_GITHUB_CURSOR_INVALID");
      }
      const repositories = snapshot.repositories.slice(offset, offset + pageSize);
      const nextOffset = offset + repositories.length;
      const hasNextPage = nextOffset < snapshot.repositories.length;
      return {
        contract: PAGE_CONTRACT,
        organization: { id: ORGANIZATION_ID, login: ORGANIZATION_LOGIN },
        installationId: INSTALLATION_ID,
        readbackId: snapshot.readbackId,
        snapshotId: snapshot.snapshotId,
        observedAt: snapshot.observedAt,
        requestCursor,
        nextCursor: hasNextPage ? `fleet-page-${snapshot.key}-${nextOffset}` : null,
        hasNextPage,
        providerTotalCount: snapshot.repositories.length,
        repositories: repositories.map((repository) => ({
          id: String(repository.id),
          fullName: repository.fullName,
          defaultBranch: repository.defaultBranch,
          archived: false,
          private: repository.private,
          fork: repository.fork,
        })),
      };
    },

    async readRepositoryHead(request: Record<string, unknown>) {
      if (request.contract !== HEAD_CONTRACT || typeof request.repositoryId !== "string" || typeof request.fullName !== "string") {
        fail("FLEET_MIGRATION_GITHUB_HEAD_REQUEST_INVALID");
      }
      const repository = await readExactRepository(request.repositoryId, request.fullName);
      const defaultRef = `refs/heads/${repository.defaultBranch}`;
      if (request.defaultRef !== defaultRef) fail("FLEET_MIGRATION_GITHUB_HEAD_REQUEST_INVALID");
      const [owner, repo] = repository.fullName.split("/");
      const ref = await dependencies.client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner,
        repo,
        ref: `heads/${repository.defaultBranch}`,
      });
      const sourceSha = (ref.data as { object?: { sha?: unknown } } | null)?.object?.sha;
      if (typeof sourceSha !== "string" || !SHA.test(sourceSha)) fail("FLEET_MIGRATION_GITHUB_HEAD_INVALID");
      const commit = await dependencies.client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner,
        repo,
        commit_sha: sourceSha,
      });
      const treeSha = (commit.data as { tree?: { sha?: unknown } } | null)?.tree?.sha;
      if (typeof treeSha !== "string" || !SHA.test(treeSha)) fail("FLEET_MIGRATION_GITHUB_HEAD_INVALID");
      const confirmed = await readExactRepository(request.repositoryId, request.fullName);
      if (!sameRepository(repository, confirmed)) fail("FLEET_MIGRATION_GITHUB_REPOSITORY_DRIFT");
      const observedAt = trustedNow();
      return {
        contract: HEAD_CONTRACT,
        readbackId: nextReadbackId("github-head-readback", { repositoryId: request.repositoryId, sourceSha, treeSha }, observedAt),
        observedAt,
        repositoryId: request.repositoryId,
        fullName: repository.fullName,
        defaultRef,
        sourceSha,
        treeSha,
      };
    },

    async readRepositoryTree(request: Record<string, unknown>) {
      if (
        request.contract !== TREE_CONTRACT
        || typeof request.repositoryId !== "string"
        || typeof request.fullName !== "string"
        || typeof request.sourceSha !== "string"
        || typeof request.treeSha !== "string"
        || !SHA.test(request.sourceSha)
        || !SHA.test(request.treeSha)
        || request.recursive !== true
      ) fail("FLEET_MIGRATION_GITHUB_TREE_REQUEST_INVALID");
      const repository = await readExactRepository(request.repositoryId, request.fullName);
      const [owner, repo] = repository.fullName.split("/");
      const response = await dependencies.client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo,
        tree_sha: request.treeSha,
        recursive: "1",
      });
      const tree = response.data as { sha?: unknown; truncated?: unknown; tree?: unknown } | null;
      if (tree?.sha !== request.treeSha || typeof tree.truncated !== "boolean" || !Array.isArray(tree.tree)) {
        fail("FLEET_MIGRATION_GITHUB_TREE_INVALID");
      }
      const entries = tree.tree.map((raw) => {
        const entry = raw as { path?: unknown; mode?: unknown; type?: unknown; sha?: unknown; size?: unknown };
        if (
          typeof entry.path !== "string"
          || !GIT_PATH.test(entry.path)
          || typeof entry.mode !== "string"
          || typeof entry.type !== "string"
          || typeof entry.sha !== "string"
          || !SHA.test(entry.sha)
        ) fail("FLEET_MIGRATION_GITHUB_TREE_INVALID");
        if (entry.type === "tree" && entry.mode === "040000") {
          return { path: entry.path, type: "TREE", mode: entry.mode, objectSha: entry.sha, size: null };
        }
        if (
          entry.type === "blob"
          && (entry.mode === "100644" || entry.mode === "100755")
          && typeof entry.size === "number"
          && Number.isSafeInteger(entry.size)
          && entry.size >= 0
        ) {
          return { path: entry.path, type: "BLOB", mode: entry.mode, objectSha: entry.sha, size: entry.size };
        }
        return fail("FLEET_MIGRATION_GITHUB_TREE_UNSUPPORTED_ENTRY");
      });
      const observedAt = trustedNow();
      return {
        contract: TREE_CONTRACT,
        readbackId: nextReadbackId("github-tree-readback", { repositoryId: request.repositoryId, treeSha: request.treeSha }, observedAt),
        observedAt,
        repositoryId: request.repositoryId,
        sourceSha: request.sourceSha,
        treeSha: request.treeSha,
        recursive: true,
        truncated: tree.truncated,
        entries,
      };
    },

    async readBlob(request: Record<string, unknown>) {
      if (
        request.contract !== BLOB_CONTRACT
        || typeof request.repositoryId !== "string"
        || typeof request.fullName !== "string"
        || typeof request.sourceSha !== "string"
        || !SHA.test(request.sourceSha)
        || typeof request.treeSha !== "string"
        || !SHA.test(request.treeSha)
        || typeof request.path !== "string"
        || !GIT_PATH.test(request.path)
        || typeof request.objectSha !== "string"
        || !SHA.test(request.objectSha)
      ) fail("FLEET_MIGRATION_GITHUB_BLOB_REQUEST_INVALID");
      const repository = await readExactRepository(request.repositoryId, request.fullName);
      const [owner, repo] = repository.fullName.split("/");
      const response = await dependencies.client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner,
        repo,
        file_sha: request.objectSha,
      });
      const blob = response.data as { sha?: unknown; size?: unknown; encoding?: unknown; content?: unknown } | null;
      if (
        blob?.sha !== request.objectSha
        || typeof blob.size !== "number"
        || !Number.isSafeInteger(blob.size)
        || blob.size < 0
        || blob.encoding !== "base64"
        || typeof blob.content !== "string"
      ) fail("FLEET_MIGRATION_GITHUB_BLOB_INVALID");
      const encoded = blob.content.replace(/\s+/gu, "");
      const bytes = Buffer.from(encoded, "base64");
      try {
        if (bytes.length !== blob.size || bytes.toString("base64") !== encoded) {
          fail("FLEET_MIGRATION_GITHUB_BLOB_INVALID");
        }
        const observedAt = trustedNow();
        return {
          contract: BLOB_CONTRACT,
          readbackId: nextReadbackId("github-blob-readback", { repositoryId: request.repositoryId, objectSha: request.objectSha }, observedAt),
          observedAt,
          repositoryId: request.repositoryId,
          sourceSha: request.sourceSha,
          treeSha: request.treeSha,
          path: request.path,
          objectSha: request.objectSha,
          size: blob.size,
          encoding: "base64",
          content: bytes.toString("base64"),
        };
      } finally {
        bytes.fill(0);
      }
    },
  });
}
