import crypto from "node:crypto";

import type { Prisma } from "@prisma/client";

import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  registerRepositoryWebhook,
  type RegisterRepositoryWebhookInput,
} from "@/lib/control-plane/repository-registration";
import { prisma } from "@/lib/prisma";
import {
  repositoryClassificationPolicy,
  repositoryPublicDiscoveryAllowed,
  type RepositoryClassificationDirective,
} from "@/lib/control-plane/repository-classification";

export const REPOSITORY_DISCOVERY_BACKFILL_CONTRACT_VERSION =
  "repository-discovery-backfill/v2";
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
  fork: boolean;
  classificationDecisionRevision: number;
  headSha: string | null;
}

export interface RepositoryDiscoveryBackfillResult {
  runId: string;
  mode: typeof REPOSITORY_DISCOVERY_BACKFILL_MODE;
  repositories: number;
  observed: number;
  eligible: number;
  archived: number;
  forks: number;
  publicPolicy: number;
  enqueued: number;
  duplicate: number;
  failed: number;
  state: "completed" | "busy" | "partial";
  ok: boolean;
}

type RepositoryDiscoveryBackfillDependencies = {
  getClient: (organization: string) => Promise<RepositoryInventoryClient>;
  classificationDecisions?: () => Promise<Map<number, RepositoryClassificationDirective>>;
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
  classificationDecisions: async () => {
    const rows = await prisma.repositoryClassificationDecision.findMany({
      orderBy: [{ repoId: "asc" }, { revision: "desc" }],
      select: {
        repoId: true,
        revision: true,
        classification: true,
        candidateMarkerPath: true,
      },
    });
    const decisions = new Map<number, RepositoryClassificationDirective>();
    for (const row of rows) {
      const repoId = Number(row.repoId);
      if (!Number.isSafeInteger(repoId) || repoId <= 0) {
        throw new Error("REPOSITORY_BACKFILL_IDENTITY_INVALID");
      }
      if (!decisions.has(repoId)) {
        decisions.set(repoId, {
          revision: row.revision,
          classification: row.classification,
          candidateMarkerPath: row.candidateMarkerPath,
        });
      }
    }
    return decisions;
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
  if (message === "REPOSITORY_CLASSIFICATION_REVISION_STALE") {
    return "REPOSITORY_BACKFILL_CLASSIFICATION_STALE";
  }
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
): Omit<RepositoryReadbackVector, "headSha" | "classificationDecisionRevision"> {
  const repository = data as {
    id?: unknown;
    full_name?: unknown;
    name?: unknown;
    default_branch?: unknown;
    archived?: unknown;
    private?: unknown;
    fork?: unknown;
  } | null;
  if (
    safeRepoId(repository?.id) !== expectedRepoId
    || typeof repository?.full_name !== "string"
    || typeof repository.name !== "string"
    || typeof repository.archived !== "boolean"
    || typeof repository.private !== "boolean"
    || typeof repository.fork !== "boolean"
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
    fork: repository.fork,
  };
}

function identityMatches(
  left: Omit<RepositoryReadbackVector, "headSha" | "classificationDecisionRevision">,
  right: Omit<RepositoryReadbackVector, "headSha" | "classificationDecisionRevision">,
): boolean {
  return left.repoId === right.repoId
    && left.repoFullName.toLowerCase() === right.repoFullName.toLowerCase()
    && left.name === right.name
    && left.defaultBranch === right.defaultBranch
    && left.archived === right.archived
    && left.private === right.private
    && left.fork === right.fork;
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
 * DISCOVERY_ALLOWED에서는 active private 저장소와 중앙 정책으로 허용된 public
 * 저장소의 default branch HEAD를 읽되 fork를 source discovery 대상으로 삼지 않는다.
 * 중앙 INFRA/EXCLUDED 정책과 append-only 분류 결정은 public HEAD 관측만 허용한다.
 * 실제 source 파일은 discovery가 해당 정책에서 terminal 분류된 뒤 읽지 않는다.
 * ALL_INSTALLED shadow inventory에서는 fork도 HEAD를 읽지만 자동 분류·승격하지 않는다.
 * HEAD read 뒤에는 canonical identity를 한 번 더 확인한다.
 */
async function readRepositoryVector(
  client: RepositoryInventoryClient,
  organization: string,
  seed: RepositoryInventorySeed,
  classificationDecision: RepositoryClassificationDirective | null,
  sourcePolicy: "DISCOVERY_ALLOWED" | "ALL_INSTALLED",
): Promise<RepositoryReadbackVector> {
  const first = parseRepositoryIdentity((await client.request(
    "GET /repositories/{repository_id}",
    { repository_id: seed.repoId },
  )).data, organization, seed.repoId);

  const centralPolicy = repositoryClassificationPolicy(first.repoFullName);
  const publicHeadAllowed = sourcePolicy === "ALL_INSTALLED"
    || first.private
    || repositoryPublicDiscoveryAllowed(first.repoFullName)
    || classificationDecision !== null
    || centralPolicy?.classification === "INFRA_REPO"
    || centralPolicy?.classification === "EXCLUDED";
  if (
    first.archived
    || (sourcePolicy === "DISCOVERY_ALLOWED" && first.fork)
    || !publicHeadAllowed
    || !first.defaultBranch
  ) {
    return {
      ...first,
      // decision이 없다는 observation도 revision 0으로 고정한다. sweep 중 첫
      // decision이 생기면 enqueue transaction이 stale vector를 거부해야 한다.
      classificationDecisionRevision: classificationDecision?.revision ?? 0,
      headSha: null,
    };
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
  return {
    ...confirmed,
    classificationDecisionRevision: classificationDecision?.revision ?? 0,
    headSha,
  };
}

export async function readRepositoryBackfillVector(
  client: RepositoryInventoryClient,
  organization: string,
  seed: RepositoryInventorySeed,
  classificationDecision: RepositoryClassificationDirective | null = null,
): Promise<RepositoryReadbackVector> {
  return readRepositoryVector(
    client,
    organization,
    seed,
    classificationDecision,
    "DISCOVERY_ALLOWED",
  );
}

/**
 * P7 BOOTSTRAP shadow는 설치에 보이는 active repository 전체의 exact default HEAD를
 * 분류 결과와 무관하게 읽어야 한다. 이 함수도 GitHub GET만 사용하며 discovery
 * enqueue나 repository 설정 변경을 수행하지 않는다.
 */
export async function readInstalledRepositoryVector(
  client: RepositoryInventoryClient,
  organization: string,
  seed: RepositoryInventorySeed,
): Promise<RepositoryReadbackVector> {
  return readRepositoryVector(
    client,
    organization,
    seed,
    null,
    "ALL_INSTALLED",
  );
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
    fork: vector.fork,
    classificationDecisionRevision: vector.classificationDecisionRevision,
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
      fork: vector.fork,
    },
    after: vector.headSha ?? undefined,
    deliveryId: repositoryBackfillDeliveryId(organization, vector, occurrenceId),
    organization,
    classificationDecisionRevision: vector.classificationDecisionRevision,
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
    forks: 0,
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
    let classificationDecisions: Map<number, RepositoryClassificationDirective>;
    try {
      client = await dependencies.getClient(input.organization);
      [seeds, classificationDecisions] = await Promise.all([
        listInstallationRepositorySeeds(client),
        dependencies.classificationDecisions?.() ?? Promise.resolve(new Map()),
      ]);
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
      forks: 0,
      publicPolicy: 0,
      enqueued: 0,
      duplicate: 0,
      failed: 0,
    };
    for (const seed of seeds) {
      try {
        const vector = await readRepositoryBackfillVector(
          client,
          input.organization,
          seed,
          classificationDecisions.get(seed.repoId) ?? null,
        );
        counts.observed += 1;
        if (vector.archived) counts.archived += 1;
        else if (vector.fork) counts.forks += 1;
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
        forks: result.forks,
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
