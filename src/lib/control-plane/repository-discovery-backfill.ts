import crypto from "node:crypto";

import type { Prisma } from "@prisma/client";

import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  registerRepositoryWebhook,
  type RegisterRepositoryWebhookInput,
} from "@/lib/control-plane/repository-registration";
import { prisma } from "@/lib/prisma";

export const REPOSITORY_DISCOVERY_BACKFILL_CONTRACT_VERSION =
  "repository-discovery-backfill/v1";
export const REPOSITORY_DISCOVERY_BACKFILL_MODE = "shadow";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 100;
const SHA_40 = /^[0-9a-f]{40}$/i;

export interface RepositoryInventoryClient {
  request(
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<{ data: unknown }>;
}

export interface RepositoryInventorySeed {
  repoId: number;
}

export interface RepositoryReadbackVector {
  repoId: number;
  repoFullName: string;
  name: string;
  defaultBranch: string | null;
  archived: boolean;
  private: boolean;
  headSha: string | null;
}

export interface RepositoryDiscoveryBackfillResult {
  runId: string;
  mode: typeof REPOSITORY_DISCOVERY_BACKFILL_MODE;
  repositories: number;
  observed: number;
  eligible: number;
  archived: number;
  publicPolicy: number;
  enqueued: number;
  duplicate: number;
  failed: number;
  state: "completed" | "busy" | "partial";
  ok: boolean;
}

type RepositoryDiscoveryBackfillDependencies = {
  getClient: (organization: string) => Promise<RepositoryInventoryClient>;
  enqueue: (
    input: RegisterRepositoryWebhookInput,
    observedAt: Date,
  ) => Promise<{ duplicate: boolean; enqueued: boolean }>;
  audit: (input: {
    action: string;
    entityId: string;
    payload: Prisma.InputJsonValue;
  }) => Promise<void>;
  now: () => Date;
  randomId: () => string;
};

const defaultDependencies: RepositoryDiscoveryBackfillDependencies = {
  getClient: async (organization) => {
    const { getInstallationContext } = await import("@/lib/github/app");
    const context = await getInstallationContext();
    assertFullOrganizationInstallation(context, organization);
    return context.octokit as unknown as RepositoryInventoryClient;
  },
  enqueue: async (input, observedAt) => registerRepositoryWebhook(input, {
    client: prisma,
    now: () => observedAt,
  }),
  audit: async (input) => {
    await prisma.auditLog.create({
      data: {
        actorLogin: "scheduler:repository-discovery-backfill",
        action: input.action,
        entityType: "RepositoryDiscoveryBackfill",
        entityId: input.entityId,
        payload: input.payload,
      },
    });
  },
  now: () => new Date(),
  randomId: () => crypto.randomUUID(),
};

function httpStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function fixedErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^REPOSITORY_BACKFILL_[A-Z0-9_]+$/.test(message)
    ? message
    : "REPOSITORY_BACKFILL_PROVIDER_READ_FAILED";
}

function safeRepoId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

export function assertFullOrganizationInstallation(
  installation: {
    repositorySelection: string;
    targetType: string;
    accountLogin: string | null;
  },
  organization: string,
): void {
  if (
    installation.repositorySelection !== "all"
    || installation.targetType !== "Organization"
    || installation.accountLogin?.toLowerCase() !== organization.toLowerCase()
  ) {
    throw new Error("REPOSITORY_BACKFILL_INSTALLATION_NOT_FULL_ORG");
  }
}

function parseRepositoryIdentity(
  data: unknown,
  organization: string,
  expectedRepoId: number,
): Omit<RepositoryReadbackVector, "headSha"> {
  const repository = data as {
    id?: unknown;
    full_name?: unknown;
    name?: unknown;
    default_branch?: unknown;
    archived?: unknown;
    private?: unknown;
  } | null;
  if (
    safeRepoId(repository?.id) !== expectedRepoId
    || typeof repository?.full_name !== "string"
    || typeof repository.name !== "string"
    || typeof repository.archived !== "boolean"
    || typeof repository.private !== "boolean"
    || (
      repository.default_branch !== null
      && typeof repository.default_branch !== "string"
    )
  ) {
    throw new Error("REPOSITORY_BACKFILL_IDENTITY_INVALID");
  }
  const [owner, repo, ...rest] = repository.full_name.split("/");
  if (
    !owner
    || !repo
    || rest.length > 0
    || owner.toLowerCase() !== organization.toLowerCase()
    || repo !== repository.name
  ) {
    throw new Error("REPOSITORY_BACKFILL_OWNER_MISMATCH");
  }
  const defaultBranch = repository.default_branch;
  if (defaultBranch !== null && (defaultBranch.length === 0 || defaultBranch.length > 255)) {
    throw new Error("REPOSITORY_BACKFILL_IDENTITY_INVALID");
  }
  return {
    repoId: expectedRepoId,
    repoFullName: repository.full_name,
    name: repository.name,
    defaultBranch,
    archived: repository.archived,
    private: repository.private,
  };
}

function identityMatches(
  left: Omit<RepositoryReadbackVector, "headSha">,
  right: Omit<RepositoryReadbackVector, "headSha">,
): boolean {
  return left.repoId === right.repoId
    && left.repoFullName.toLowerCase() === right.repoFullName.toLowerCase()
    && left.name === right.name
    && left.defaultBranch === right.defaultBranch
    && left.archived === right.archived
    && left.private === right.private;
}

/**
 * GitHub App installation에 보이는 전체 저장소를 numeric ID만으로 수집한다.
 * 이름은 pagination 도중 rename될 수 있으므로 exact readback 전에는 사용하지 않는다.
 */
export async function listInstallationRepositorySeeds(
  client: RepositoryInventoryClient,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<RepositoryInventorySeed[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) {
    throw new Error("REPOSITORY_BACKFILL_PAGE_SIZE_INVALID");
  }
  const repoIds = new Set<number>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await client.request("GET /installation/repositories", {
      per_page: pageSize,
      page,
    });
    const repositories = (response.data as { repositories?: unknown } | null)?.repositories;
    if (!Array.isArray(repositories)) {
      throw new Error("REPOSITORY_BACKFILL_PAGE_INVALID");
    }
    for (const repository of repositories) {
      const repoId = safeRepoId((repository as { id?: unknown } | null)?.id);
      if (!repoId) throw new Error("REPOSITORY_BACKFILL_IDENTITY_INVALID");
      repoIds.add(repoId);
    }
    if (repositories.length < pageSize) {
      return [...repoIds].sort((left, right) => left - right).map((repoId) => ({ repoId }));
    }
  }
  throw new Error("REPOSITORY_BACKFILL_PAGE_LIMIT_EXCEEDED");
}

/**
 * 이름이 아니라 numeric repository ID로 canonical identity를 읽는다. active private
 * 저장소는 default branch HEAD도 함께 읽고 identity를 한 번 더 확인한다.
 */
export async function readRepositoryBackfillVector(
  client: RepositoryInventoryClient,
  organization: string,
  seed: RepositoryInventorySeed,
): Promise<RepositoryReadbackVector> {
  const first = parseRepositoryIdentity((await client.request(
    "GET /repositories/{repository_id}",
    { repository_id: seed.repoId },
  )).data, organization, seed.repoId);

  if (first.archived || !first.private || !first.defaultBranch) {
    return { ...first, headSha: null };
  }

  const [owner, repo] = first.repoFullName.split("/");
  let headSha: string | null = null;
  try {
    const commit = (await client.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner,
      repo,
      ref: first.defaultBranch,
    })).data as { sha?: unknown } | null;
    if (typeof commit?.sha !== "string" || !SHA_40.test(commit.sha)) {
      throw new Error("REPOSITORY_BACKFILL_HEAD_INVALID");
    }
    headSha = commit.sha.toLowerCase();
  } catch (error) {
    const status = httpStatus(error);
    if (status !== 404 && status !== 409) throw error;
  }

  const confirmed = parseRepositoryIdentity((await client.request(
    "GET /repositories/{repository_id}",
    { repository_id: seed.repoId },
  )).data, organization, seed.repoId);
  if (!identityMatches(first, confirmed)) {
    throw new Error("REPOSITORY_BACKFILL_VECTOR_DRIFT");
  }
  return { ...confirmed, headSha };
}

export function repositoryBackfillDeliveryId(
  organization: string,
  vector: RepositoryReadbackVector,
  occurrenceId: string,
): string {
  const digest = jsonDigest({
    contractVersion: REPOSITORY_DISCOVERY_BACKFILL_CONTRACT_VERSION,
    occurrenceId,
    organization: organization.toLowerCase(),
    repoId: String(vector.repoId),
    repoFullName: vector.repoFullName.toLowerCase(),
    name: vector.name,
    defaultBranch: vector.defaultBranch,
    archived: vector.archived,
    private: vector.private,
    headSha: vector.headSha,
  } as JsonValue);
  return `repository-backfill:${digest}`;
}

export function repositoryBackfillRegistrationInput(
  organization: string,
  vector: RepositoryReadbackVector,
  occurrenceId: string,
): RegisterRepositoryWebhookInput {
  return {
    event: "reconcile",
    action: "full-org-readback",
    repository: {
      id: vector.repoId,
      full_name: vector.repoFullName,
      name: vector.name,
      default_branch: vector.defaultBranch,
      archived: vector.archived,
      private: vector.private,
    },
    after: vector.headSha ?? undefined,
    deliveryId: repositoryBackfillDeliveryId(organization, vector, occurrenceId),
    organization,
  };
}

let running = false;

/**
 * GitHub에는 GET만 수행한다. DB에는 exact provider vector를 기존 discovery run으로
 * enqueue할 뿐 caller/bootstrap/settings/PR mutation을 수행하지 않는다.
 */
export async function reconcileOrganizationRepositoryDiscovery(
  input: { organization: string; mode?: string },
  dependencies: RepositoryDiscoveryBackfillDependencies = defaultDependencies,
): Promise<RepositoryDiscoveryBackfillResult> {
  const mode = input.mode ?? REPOSITORY_DISCOVERY_BACKFILL_MODE;
  if (mode !== REPOSITORY_DISCOVERY_BACKFILL_MODE) {
    throw new Error("REPOSITORY_BACKFILL_MODE_NOT_SHADOW");
  }
  const runId = dependencies.randomId();
  const empty = {
    runId,
    mode: REPOSITORY_DISCOVERY_BACKFILL_MODE,
    repositories: 0,
    observed: 0,
    eligible: 0,
    archived: 0,
    publicPolicy: 0,
    enqueued: 0,
    duplicate: 0,
    failed: 0,
  } as const;
  if (running) return { ...empty, state: "busy", ok: false };
  running = true;
  try {
    await dependencies.audit({
      action: "control-plane.repository-discovery-backfill.started",
      entityId: runId,
      payload: {
        contractVersion: REPOSITORY_DISCOVERY_BACKFILL_CONTRACT_VERSION,
        organization: input.organization,
        mode,
      },
    });
    let client: RepositoryInventoryClient;
    let seeds: RepositoryInventorySeed[];
    try {
      client = await dependencies.getClient(input.organization);
      seeds = await listInstallationRepositorySeeds(client);
    } catch (error) {
      const code = fixedErrorCode(error);
      await dependencies.audit({
        action: "control-plane.repository-discovery-backfill.failed",
        entityId: runId,
        payload: { code, stage: "inventory" },
      });
      return { ...empty, failed: 1, state: "partial", ok: false };
    }

    const counts = {
      observed: 0,
      eligible: 0,
      archived: 0,
      publicPolicy: 0,
      enqueued: 0,
      duplicate: 0,
      failed: 0,
    };
    for (const seed of seeds) {
      try {
        const vector = await readRepositoryBackfillVector(client, input.organization, seed);
        counts.observed += 1;
        if (vector.archived) counts.archived += 1;
        else if (!vector.private) counts.publicPolicy += 1;
        else counts.eligible += 1;
        const observedAt = dependencies.now();
        const result = await dependencies.enqueue(
          repositoryBackfillRegistrationInput(input.organization, vector, runId),
          observedAt,
        );
        if (result.duplicate) counts.duplicate += 1;
        else if (result.enqueued) counts.enqueued += 1;
      } catch (error) {
        counts.failed += 1;
        await dependencies.audit({
          action: "control-plane.repository-discovery-backfill.repository_failed",
          entityId: runId,
          payload: {
            repoId: String(seed.repoId),
            code: fixedErrorCode(error),
          },
        });
      }
    }
    const state = counts.failed === 0 ? "completed" : "partial";
    const result: RepositoryDiscoveryBackfillResult = {
      ...empty,
      repositories: seeds.length,
      ...counts,
      state,
      ok: state === "completed",
    };
    await dependencies.audit({
      action: "control-plane.repository-discovery-backfill.completed",
      entityId: runId,
      payload: {
        contractVersion: REPOSITORY_DISCOVERY_BACKFILL_CONTRACT_VERSION,
        organization: input.organization,
        mode,
        repositories: result.repositories,
        observed: result.observed,
        eligible: result.eligible,
        archived: result.archived,
        publicPolicy: result.publicPolicy,
        enqueued: result.enqueued,
        duplicate: result.duplicate,
        failed: result.failed,
        state: result.state,
      },
    });
    return result;
  } finally {
    running = false;
  }
}
