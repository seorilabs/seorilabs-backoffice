import { Prisma } from "@prisma/client";
import type { Octokit } from "@/lib/github/app";
import {
  discoverRepository,
  readCurrentRepositoryHead,
  readExactRepositoryTree,
  REPOSITORY_DISCOVERY_CONTRACT_VERSION,
  REPOSITORY_DISCOVERY_LEASE_MS,
  REPOSITORY_DISCOVERY_MAX_ATTEMPTS,
  REPOSITORY_DISCOVERY_TERMINAL_SLO_MS,
  type RepositoryDiscoveryReason,
  type RepositoryDiscoveryResult,
  type RepositoryTreeSnapshot,
} from "@/lib/control-plane/repository-discovery";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { registerRepositoryWebhook } from "@/lib/control-plane/repository-registration";
import {
  ControlPlaneError,
  recordDiscoveryObservationInTransaction,
} from "@/lib/control-plane/service";
import { readExactSourceFile } from "@/lib/github/source-observation";
import { prisma } from "@/lib/prisma";
import type {
  RepositoryClassification,
  RepositoryClassificationDirective,
} from "@/lib/control-plane/repository-classification";

export type RepositoryDiscoveryClaim = {
  id: string;
  repoId: bigint;
  generation: number;
  leaseGeneration: number;
  workerId: string;
  sourceSha: string | null;
  sourceRef: string | null;
  createdAt: Date;
  attempts: number;
  registration: {
    repoFullName: string;
    defaultBranch: string | null;
    archived: boolean;
    fork: boolean | null;
    reconcileGeneration: number | null;
    classificationDecision: RepositoryClassificationDirective | null;
  };
};

export type RepositoryDiscoveryServiceDependencies = {
  client: typeof prisma;
  getOctokit: () => Promise<Octokit>;
  now: () => Date;
};

const defaultDependencies: RepositoryDiscoveryServiceDependencies = {
  client: prisma,
  getOctokit: async () => {
    const { getInstallationOctokit } = await import("@/lib/github/app");
    return getInstallationOctokit();
  },
  now: () => new Date(),
};

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function publicDiscoveryState(input: {
  sourceSha: string | null;
  reasonCode: RepositoryDiscoveryReason | null;
  classification: RepositoryClassification | null;
  candidates: RepositoryDiscoveryResult["candidates"];
}): Prisma.InputJsonValue {
  return jsonInput({
    contractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
    sourceSha: input.sourceSha,
    reasonCode: input.reasonCode,
    classification: input.classification,
    candidates: input.candidates,
  });
}

function displayNameFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || slug;
}

function marketTargets(result: Extract<RepositoryDiscoveryResult, { status: "ACTIVE" }>): string[] {
  const markets = new Set<string>();
  for (const target of result.buildTargets) {
    if (target.market === "google-play") markets.add("play");
    if (target.market === "app-store") markets.add("appstore");
    if (target.market === "apps-in-toss") markets.add("ait");
  }
  return [...markets].sort();
}

function aitAppName(result: Extract<RepositoryDiscoveryResult, { status: "ACTIVE" }>): string | null {
  const target = result.buildTargets.find((item) => item.market === "apps-in-toss");
  const appName = target?.configuration?.appName;
  return typeof appName === "string" ? appName : null;
}

function normalizedMarketTargets(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase()))].sort()
    : [];
}

export function appMarketIdentityConflict(input: {
  existing: {
    playPackage: string | null;
    iosBundle: string | null;
    aitAppName: string | null;
    marketTargets: unknown;
  };
  discovered: {
    playPackage: string | null;
    iosBundle: string | null;
    aitAppName: string | null;
    marketTargets: string[];
  };
}): boolean {
  const fieldConflict = (
    existing: string | null,
    discovered: string | null,
  ) => existing !== null
    && discovered !== null
    && existing.toLowerCase() !== discovered.toLowerCase();
  if (
    fieldConflict(input.existing.playPackage, input.discovered.playPackage)
    || fieldConflict(input.existing.iosBundle, input.discovered.iosBundle)
    || fieldConflict(input.existing.aitAppName, input.discovered.aitAppName)
  ) return true;
  return false;
}

export function reconciledMarketTargets(existing: unknown, discovered: readonly string[]): string[] {
  return [...new Set([
    ...normalizedMarketTargets(existing),
    ...discovered.map((target) => target.toLowerCase()),
  ])].sort();
}

async function activeClaim(
  tx: Prisma.TransactionClient,
  claim: RepositoryDiscoveryClaim,
  now: Date,
) {
  // enqueue와 같은 registration -> run lock 순서를 사용해 generation 전환과
  // worker 완료가 교착 없이 직렬화되게 한다.
  await tx.$queryRaw`SELECT repoId FROM repository_registration WHERE repoId = ${claim.repoId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM repository_discovery_run WHERE id = ${claim.id} FOR UPDATE`;
  const run = await tx.repositoryDiscoveryRun.findUnique({
    where: { id: claim.id },
    include: { registration: true },
  });
  if (
    !run
    || run.status !== "RUNNING"
    || run.workerId !== claim.workerId
    || run.leaseGeneration !== claim.leaseGeneration
    || !run.leaseExpiresAt
    || run.leaseExpiresAt.getTime() <= now.getTime()
    || (run.registration.reconcileGeneration ?? 0) !== run.generation
    || run.registration.archived
  ) return null;
  return run;
}

async function finishWithoutObservation(input: {
  claim: RepositoryDiscoveryClaim;
  sourceSha: string | null;
  status: "NEEDS_INPUT" | "EXCLUDED" | "STALE" | "FAILED";
  reasonCode: RepositoryDiscoveryReason;
  candidates?: RepositoryDiscoveryResult["candidates"];
  candidateDigest?: string | null;
  managementKind?: "UNCLASSIFIED" | "APP" | "PLATFORM_PRODUCER";
  classification?: RepositoryClassification | null;
}, dependencies: RepositoryDiscoveryServiceDependencies): Promise<boolean> {
  const now = dependencies.now();
  return dependencies.client.$transaction(async (tx) => {
    const run = await activeClaim(tx, input.claim, now);
    if (!run) return false;
    const candidates = input.candidates ?? [];
    await tx.repositoryDiscoveryRun.update({
      where: { id: run.id },
      data: {
        sourceSha: input.sourceSha,
        status: input.status,
        reasonCode: input.reasonCode,
        classification: input.classification ?? null,
        contractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
        candidateDigest: input.candidateDigest
          ?? jsonDigest(candidates as unknown as JsonValue),
        workerId: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    });
    await tx.repositoryRegistration.update({
      where: { repoId: run.repoId },
      data: {
        status: input.status === "EXCLUDED" ? "MANAGED" : "NEEDS_INPUT",
        managementKind: input.managementKind ?? "UNCLASSIFIED",
        classification: input.classification ?? null,
        discoveryContractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
        discoveryCandidates: publicDiscoveryState({
          sourceSha: input.sourceSha,
          reasonCode: input.reasonCode,
          classification: input.classification ?? null,
          candidates,
        }),
        ...(input.sourceSha ? { lastDefaultPushSha: input.sourceSha } : {}),
        lastReconciledSha: input.sourceSha,
        lastDiscoveryReason: input.reasonCode,
      },
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.claim.workerId,
        action: `control-plane.repository-discovery.${input.status.toLowerCase()}`,
        entityType: "RepositoryDiscoveryRun",
        entityId: run.id,
        payload: {
          repoId: run.repoId.toString(),
          generation: run.generation,
          sourceSha: input.sourceSha,
          reasonCode: input.reasonCode,
          candidateDigest: input.candidateDigest ?? null,
          classification: input.classification ?? null,
        },
      },
    });
    return true;
  });
}

async function finishActive(input: {
  claim: RepositoryDiscoveryClaim;
  snapshot: RepositoryTreeSnapshot;
  result: Extract<RepositoryDiscoveryResult, { status: "ACTIVE" }>;
}, dependencies: RepositoryDiscoveryServiceDependencies): Promise<{
  completed: boolean;
  observationId: string | null;
  reasonCode: RepositoryDiscoveryReason | null;
}> {
  const now = dependencies.now();
  return dependencies.client.$transaction(async (tx) => {
    const run = await activeClaim(tx, input.claim, now);
    if (!run) return { completed: false, observationId: null, reasonCode: "SOURCE_DRIFT" };
    if (
      run.registration.repoFullName.toLowerCase() !== input.snapshot.fullName.toLowerCase()
      || run.registration.defaultBranch !== input.snapshot.defaultBranch
      || run.sourceSha?.toLowerCase() !== input.snapshot.sourceSha
    ) {
      await tx.repositoryDiscoveryRun.update({
        where: { id: run.id },
        data: {
          status: "STALE",
          reasonCode: "SOURCE_DRIFT",
          workerId: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });
      return { completed: false, observationId: null, reasonCode: "SOURCE_DRIFT" };
    }

    const slug = input.snapshot.name;
    const [byRepoId, byFullName, bySlug] = await Promise.all([
      tx.app.findUnique({ where: { repoId: run.repoId } }),
      tx.app.findUnique({ where: { repoFullName: input.snapshot.fullName } }),
      tx.app.findUnique({ where: { slug } }),
    ]);
    const adopted = byRepoId ?? (byFullName?.repoId === null ? byFullName : null);
    const android = input.result.buildTargets.find((target) => target.market === "google-play");
    const ios = input.result.buildTargets.find((target) => target.market === "app-store");
    const discoveredIdentity = {
      playPackage: android?.packageId ?? null,
      iosBundle: ios?.bundleId ?? null,
      aitAppName: aitAppName(input.result),
      marketTargets: marketTargets(input.result),
    };
    const repositoryIdentityConflict = (
      byFullName && byFullName.id !== adopted?.id
    ) || (
      bySlug && bySlug.id !== adopted?.id
    );
    const marketIdentityConflict = Boolean(adopted && appMarketIdentityConflict({
      existing: adopted,
      discovered: discoveredIdentity,
    }));
    const productIdentityConflict = Boolean(adopted && (
      adopted.type !== input.result.appType || adopted.engine !== input.result.engine
    ));
    const identityReason: RepositoryDiscoveryReason | null = repositoryIdentityConflict
      ? "APP_IDENTITY_CONFLICT"
      : productIdentityConflict
        ? "APP_IDENTITY_CONFLICT"
        : marketIdentityConflict
          ? "APP_MARKET_IDENTITY_CONFLICT"
          : null;
    if (identityReason) {
      await tx.repositoryDiscoveryRun.update({
        where: { id: run.id },
        data: {
          status: "NEEDS_INPUT",
          reasonCode: identityReason,
          classification: input.claim.registration.classificationDecision?.classification === "PRODUCT_APP"
            ? "PRODUCT_APP"
            : null,
          contractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
          candidateDigest: input.result.candidateDigest,
          workerId: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });
      await tx.repositoryRegistration.update({
        where: { repoId: run.repoId },
        data: {
          status: "NEEDS_INPUT",
          managementKind: input.claim.registration.classificationDecision?.classification === "PRODUCT_APP"
            ? "APP"
            : "UNCLASSIFIED",
          classification: input.claim.registration.classificationDecision?.classification === "PRODUCT_APP"
            ? "PRODUCT_APP"
            : null,
          discoveryContractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
          discoveryCandidates: publicDiscoveryState({
            sourceSha: input.snapshot.sourceSha,
            reasonCode: identityReason,
            classification: input.claim.registration.classificationDecision?.classification === "PRODUCT_APP"
              ? "PRODUCT_APP"
              : null,
            candidates: input.result.candidates,
          }),
          lastDefaultPushSha: input.snapshot.sourceSha,
          lastReconciledSha: input.snapshot.sourceSha,
          lastDiscoveryReason: identityReason,
        },
      });
      await tx.auditLog.create({
        data: {
          actorLogin: input.claim.workerId,
          action: "control-plane.repository-discovery.needs_input",
          entityType: "RepositoryDiscoveryRun",
          entityId: run.id,
          payload: {
            repoId: run.repoId.toString(),
            generation: run.generation,
            sourceSha: input.snapshot.sourceSha,
            reasonCode: identityReason,
            candidateDigest: input.result.candidateDigest,
          },
        },
      });
      return { completed: true, observationId: null, reasonCode: identityReason };
    }

    const app = adopted
      ? await tx.app.update({
          where: { id: adopted.id },
          data: {
            slug,
            repoFullName: input.snapshot.fullName,
            repoId: run.repoId,
            type: input.result.appType,
            engine: input.result.engine,
            isPublicRepo: !input.snapshot.private,
            playPackage: adopted.playPackage ?? discoveredIdentity.playPackage,
            iosBundle: adopted.iosBundle ?? discoveredIdentity.iosBundle,
            aitAppName: adopted.aitAppName ?? discoveredIdentity.aitAppName,
            marketTargets: reconciledMarketTargets(adopted.marketTargets, discoveredIdentity.marketTargets),
            configHash: input.result.candidateDigest,
            configSyncedAt: run.createdAt,
          },
        })
      : await tx.app.create({
          data: {
            slug,
            displayName: displayNameFromSlug(slug),
            repoFullName: input.snapshot.fullName,
            repoId: run.repoId,
            type: input.result.appType,
            engine: input.result.engine,
            status: "ACTIVE",
            isPublicRepo: !input.snapshot.private,
            playPackage: discoveredIdentity.playPackage,
            iosBundle: discoveredIdentity.iosBundle,
            aitAppName: discoveredIdentity.aitAppName,
            marketTargets: discoveredIdentity.marketTargets,
            configHash: input.result.candidateDigest,
            configSyncedAt: run.createdAt,
          },
        });
    await tx.$queryRaw`SELECT id FROM app WHERE id = ${app.id} FOR UPDATE`;
    const recorded = await recordDiscoveryObservationInTransaction(tx, {
      repoId: run.repoId,
      sourceSha: input.snapshot.sourceSha,
      sourceRef: input.snapshot.sourceRef,
      observedAt: run.createdAt,
      observedBy: input.claim.workerId,
      idempotencyKey: `repository-discovery:${run.id}`,
      workflowCaller: input.result.workflowCaller,
      buildBindings: input.result.buildBindings,
      payload: input.result.payload,
      buildTargets: input.result.buildTargets,
    });
    await tx.repositoryDiscoveryRun.update({
      where: { id: run.id },
      data: {
        status: "MANAGED",
        reasonCode: null,
        classification: "PRODUCT_APP",
        contractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
        candidateDigest: input.result.candidateDigest,
        observationId: recorded.observation.id,
        workerId: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    });
    await tx.repositoryRegistration.update({
      where: { repoId: run.repoId },
      data: {
        status: "MANAGED",
        managementKind: "APP",
        classification: "PRODUCT_APP",
        discoveryContractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
        discoveryCandidates: publicDiscoveryState({
          sourceSha: input.snapshot.sourceSha,
          reasonCode: null,
          classification: "PRODUCT_APP",
          candidates: input.result.candidates,
        }),
        lastDefaultPushSha: input.snapshot.sourceSha,
        lastReconciledSha: input.snapshot.sourceSha,
        lastDiscoveryReason: null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.claim.workerId,
        action: "control-plane.repository-discovery.managed",
        entityType: "RepositoryDiscoveryRun",
        entityId: run.id,
        payload: {
          repoId: run.repoId.toString(),
          generation: run.generation,
          sourceSha: input.snapshot.sourceSha,
          observationId: recorded.observation.id,
          candidateDigest: input.result.candidateDigest,
          classification: "PRODUCT_APP",
        },
      },
    });
    return { completed: true, observationId: recorded.observation.id, reasonCode: null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function recoverRepositoryDiscoveryRuns(
  dependencies: RepositoryDiscoveryServiceDependencies = defaultDependencies,
): Promise<{ requeued: number; failed: number; overdue: number }> {
  const now = dependencies.now();
  const overdueBefore = new Date(now.getTime() - REPOSITORY_DISCOVERY_TERMINAL_SLO_MS);
  return dependencies.client.$transaction(async (tx) => {
    const overdue = await tx.repositoryDiscoveryRun.findMany({
      where: {
        status: { in: ["QUEUED", "RUNNING"] },
        createdAt: { lte: overdueBefore },
      },
      select: { id: true, repoId: true, generation: true },
    });
    let overdueCount = 0;
    for (const run of overdue) {
      const updated = await tx.repositoryDiscoveryRun.updateMany({
        where: {
          id: run.id,
          status: { in: ["QUEUED", "RUNNING"] },
          createdAt: { lte: overdueBefore },
          generation: run.generation,
        },
        data: {
          status: "FAILED",
          reasonCode: "DISCOVERY_SLO_EXCEEDED",
          workerId: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });
      if (updated.count !== 1) continue;
      await tx.repositoryRegistration.updateMany({
        where: { repoId: run.repoId, reconcileGeneration: run.generation },
        data: { status: "NEEDS_INPUT", lastDiscoveryReason: "DISCOVERY_SLO_EXCEEDED" },
      });
      overdueCount++;
    }

    const expired = await tx.repositoryDiscoveryRun.findMany({
      where: {
        status: "RUNNING",
        leaseExpiresAt: { lte: now },
        id: { notIn: overdue.map((run) => run.id) },
      },
      select: { id: true, repoId: true, generation: true, attempts: true },
    });
    let requeued = 0;
    let failed = 0;
    for (const run of expired) {
      if (run.attempts < REPOSITORY_DISCOVERY_MAX_ATTEMPTS) {
        const updated = await tx.repositoryDiscoveryRun.updateMany({
          where: {
            id: run.id,
            status: "RUNNING",
            leaseExpiresAt: { lte: now },
            attempts: run.attempts,
            generation: run.generation,
          },
          data: {
            status: "QUEUED",
            reasonCode: null,
            workerId: null,
            leaseExpiresAt: null,
            availableAt: now,
          },
        });
        if (updated.count === 1) requeued++;
      } else {
        const updated = await tx.repositoryDiscoveryRun.updateMany({
          where: {
            id: run.id,
            status: "RUNNING",
            leaseExpiresAt: { lte: now },
            attempts: run.attempts,
            generation: run.generation,
          },
          data: {
            status: "FAILED",
            reasonCode: "SOURCE_READ_UNAVAILABLE",
            workerId: null,
            leaseExpiresAt: null,
            completedAt: now,
          },
        });
        if (updated.count !== 1) continue;
        await tx.repositoryRegistration.updateMany({
          where: { repoId: run.repoId, reconcileGeneration: run.generation },
          data: { status: "NEEDS_INPUT", lastDiscoveryReason: "SOURCE_READ_UNAVAILABLE" },
        });
        failed++;
      }
    }
    return { requeued, failed, overdue: overdueCount };
  });
}

export async function claimRepositoryDiscoveryRun(
  workerId: string,
  dependencies: RepositoryDiscoveryServiceDependencies = defaultDependencies,
): Promise<RepositoryDiscoveryClaim | null> {
  if (!/^[A-Za-z0-9_.:@/-]{1,128}$/.test(workerId)) throw new Error("WORKER_ID_INVALID");
  const now = dependencies.now();
  const leaseExpiresAt = new Date(now.getTime() + REPOSITORY_DISCOVERY_LEASE_MS);
  return dependencies.client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM repository_discovery_run
      WHERE status = 'QUEUED' AND availableAt <= ${now}
      ORDER BY createdAt ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const id = rows[0]?.id;
    if (!id) return null;
    const updated = await tx.repositoryDiscoveryRun.update({
      where: { id },
      data: {
        status: "RUNNING",
        attempts: { increment: 1 },
        leaseGeneration: { increment: 1 },
        workerId,
        leaseExpiresAt,
        startedAt: now,
      },
      include: {
        registration: {
          include: {
            classificationDecisions: {
              orderBy: { revision: "desc" },
              take: 1,
            },
          },
        },
      },
    });
    const decision = updated.registration.classificationDecisions[0] ?? null;
    return {
      id: updated.id,
      repoId: updated.repoId,
      generation: updated.generation,
      leaseGeneration: updated.leaseGeneration,
      workerId,
      sourceSha: updated.sourceSha,
      sourceRef: updated.sourceRef,
      createdAt: updated.createdAt,
      attempts: updated.attempts,
      registration: {
        repoFullName: updated.registration.repoFullName,
        defaultBranch: updated.registration.defaultBranch,
        archived: updated.registration.archived,
        fork: updated.registration.fork,
        reconcileGeneration: updated.registration.reconcileGeneration,
        classificationDecision: decision ? {
          revision: decision.revision,
          classification: decision.classification,
          candidateMarkerPath: decision.candidateMarkerPath,
        } : null,
      },
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function renewRepositoryDiscoveryClaim(
  claim: RepositoryDiscoveryClaim,
  dependencies: RepositoryDiscoveryServiceDependencies,
): Promise<boolean> {
  const now = dependencies.now();
  const leaseExpiresAt = new Date(now.getTime() + REPOSITORY_DISCOVERY_LEASE_MS);
  return dependencies.client.$transaction(async (tx) => {
    const run = await activeClaim(tx, claim, now);
    if (!run) return false;
    await tx.repositoryDiscoveryRun.update({
      where: { id: run.id },
      data: { leaseExpiresAt },
    });
    return true;
  });
}

async function retryClaim(
  claim: RepositoryDiscoveryClaim,
  dependencies: RepositoryDiscoveryServiceDependencies,
): Promise<"RETRY" | "FAILED" | "DISCARDED"> {
  const now = dependencies.now();
  if (
    claim.attempts >= REPOSITORY_DISCOVERY_MAX_ATTEMPTS
    || now.getTime() - claim.createdAt.getTime() >= REPOSITORY_DISCOVERY_TERMINAL_SLO_MS
  ) {
    const reasonCode = now.getTime() - claim.createdAt.getTime()
      >= REPOSITORY_DISCOVERY_TERMINAL_SLO_MS
      ? "DISCOVERY_SLO_EXCEEDED"
      : "SOURCE_READ_UNAVAILABLE";
    const completed = await finishWithoutObservation({
      claim,
      sourceSha: claim.sourceSha,
      status: "FAILED",
      reasonCode,
      ...unresolvedClassification(claim),
    }, dependencies);
    return completed ? "FAILED" : "DISCARDED";
  }
  const retryAt = new Date(now.getTime() + 5_000 * claim.attempts);
  const updated = await dependencies.client.$transaction(async (tx) => {
    const run = await activeClaim(tx, claim, now);
    if (!run) return false;
    await tx.repositoryDiscoveryRun.update({
      where: { id: run.id },
      data: {
        status: "QUEUED",
        workerId: null,
        leaseExpiresAt: null,
        availableAt: retryAt,
      },
    });
    return true;
  });
  return updated ? "RETRY" : "DISCARDED";
}

function unresolvedClassification(claim: RepositoryDiscoveryClaim) {
  return claim.registration.classificationDecision?.classification === "PRODUCT_APP"
    ? { managementKind: "APP" as const, classification: "PRODUCT_APP" as const }
    : {};
}

async function enqueueCurrentHead(
  claim: RepositoryDiscoveryClaim,
  sourceSha: string,
  defaultBranch: string,
  dependencies: RepositoryDiscoveryServiceDependencies,
  providerFacts: { private: boolean; fork: boolean },
): Promise<void> {
  try {
    await registerRepositoryWebhook({
      event: "reconcile",
      action: "source-drift",
      repository: {
        id: Number(claim.repoId),
        full_name: claim.registration.repoFullName,
        name: claim.registration.repoFullName.split("/").at(-1),
        default_branch: defaultBranch,
        archived: false,
        private: providerFacts.private,
        fork: providerFacts.fork,
      },
      after: sourceSha,
      deliveryId: `reconcile:${claim.repoId.toString()}:${claim.generation}:${sourceSha}`,
      organization: claim.registration.repoFullName.split("/")[0],
      // decision이 없었던 claim도 revision 0을 관측한 것이다. STALE 완료와
      // enqueue 사이에 사람이 분류하면 예전 worker가 새 decision generation을
      // 덮지 못하게 registration CAS에 항상 결합한다.
      classificationDecisionRevision: claim.registration.classificationDecision?.revision ?? 0,
    }, { client: dependencies.client, now: dependencies.now });
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "REPOSITORY_CLASSIFICATION_REVISION_STALE"
    ) return;
    throw error;
  }
}

export async function processRepositoryDiscoveryClaim(
  claim: RepositoryDiscoveryClaim,
  dependencies: RepositoryDiscoveryServiceDependencies = defaultDependencies,
): Promise<{
  status: "MANAGED" | "NEEDS_INPUT" | "EXCLUDED" | "STALE" | "RETRY" | "FAILED" | "DISCARDED";
  reasonCode: RepositoryDiscoveryReason | null;
  observationId?: string | null;
}> {
  const unresolvedProduct = unresolvedClassification(claim);
  let octokit: Octokit;
  try {
    octokit = await dependencies.getOctokit();
  } catch {
    const status = await retryClaim(claim, dependencies);
    return { status, reasonCode: "SOURCE_READ_UNAVAILABLE" };
  }

  const tree = await readExactRepositoryTree(octokit, {
    repoId: Number(claim.repoId),
    fullName: claim.registration.repoFullName,
    expectedSourceSha: claim.sourceSha,
    classificationDecision: claim.registration.classificationDecision,
  });
  if (tree.status === "RETRY") {
    const status = await retryClaim(claim, dependencies);
    return { status, reasonCode: tree.reasonCode };
  }
  if (tree.status === "STALE") {
    const completed = await finishWithoutObservation({
      claim,
      sourceSha: claim.sourceSha,
      status: "STALE",
      reasonCode: "SOURCE_DRIFT",
      ...unresolvedProduct,
    }, dependencies);
    if (completed) {
      await enqueueCurrentHead(
        claim,
        tree.actualHeadSha,
        tree.defaultBranch,
        dependencies,
        { private: tree.private, fork: tree.fork },
      );
    }
    return { status: completed ? "STALE" : "DISCARDED", reasonCode: "SOURCE_DRIFT" };
  }
  if (tree.status === "NEEDS_INPUT") {
    const completed = await finishWithoutObservation({
      claim,
      sourceSha: claim.sourceSha,
      status: "NEEDS_INPUT",
      reasonCode: tree.reasonCode,
      ...unresolvedProduct,
    }, dependencies);
    return { status: completed ? "NEEDS_INPUT" : "DISCARDED", reasonCode: tree.reasonCode };
  }
  if (tree.status === "CLASSIFIED") {
    const completed = await finishWithoutObservation({
      claim,
      sourceSha: claim.sourceSha,
      status: "EXCLUDED",
      reasonCode: tree.reasonCode,
      managementKind: "UNCLASSIFIED",
      classification: tree.classification,
    }, dependencies);
    return { status: completed ? "EXCLUDED" : "DISCARDED", reasonCode: tree.reasonCode };
  }

  const snapshot = tree.snapshot;
  if (!claim.sourceSha) {
    const now = dependencies.now();
    const bound = await dependencies.client.repositoryDiscoveryRun.updateMany({
      where: {
        id: claim.id,
        status: "RUNNING",
        workerId: claim.workerId,
        leaseGeneration: claim.leaseGeneration,
        leaseExpiresAt: { gt: now },
        sourceSha: null,
      },
      data: { sourceSha: snapshot.sourceSha, sourceRef: snapshot.sourceRef },
    });
    if (bound.count !== 1) return { status: "DISCARDED", reasonCode: "SOURCE_DRIFT" };
    claim.sourceSha = snapshot.sourceSha;
    claim.sourceRef = snapshot.sourceRef;
  }

  let result: RepositoryDiscoveryResult;
  let claimLost = false;
  try {
    result = await discoverRepository(snapshot, async (path, maxBytes) => {
      if (!await renewRepositoryDiscoveryClaim(claim, dependencies)) {
        claimLost = true;
        throw new Error("REPOSITORY_DISCOVERY_CLAIM_LOST");
      }
      return readExactSourceFile(octokit, {
        repoId: claim.repoId,
        fullName: snapshot.fullName,
        sourceSha: snapshot.sourceSha,
        sourceRef: snapshot.sourceRef,
        path,
        allowedPaths: [path],
        ...(maxBytes === undefined ? {} : { maxBytes }),
      });
    }, claim.registration.classificationDecision);
  } catch {
    if (claimLost) return { status: "DISCARDED", reasonCode: "SOURCE_DRIFT" };
    const status = await retryClaim(claim, dependencies);
    return { status, reasonCode: "SOURCE_READ_UNAVAILABLE" };
  }

  if (!await renewRepositoryDiscoveryClaim(claim, dependencies)) {
    return { status: "DISCARDED", reasonCode: "SOURCE_DRIFT" };
  }

  const head = await readCurrentRepositoryHead(octokit, {
    repoId: Number(claim.repoId),
    fullName: snapshot.fullName,
    publicDiscoveryApproved: claim.registration.classificationDecision !== null,
  });
  if (head.status !== "READY") {
    if (head.status === "RETRY") {
      const status = await retryClaim(claim, dependencies);
      return { status, reasonCode: head.reasonCode };
    }
    const completed = await finishWithoutObservation({
      claim,
      sourceSha: snapshot.sourceSha,
      status: "NEEDS_INPUT",
      reasonCode: head.reasonCode,
      candidates: result.candidates,
      candidateDigest: result.candidateDigest,
      ...unresolvedProduct,
    }, dependencies);
    return { status: completed ? "NEEDS_INPUT" : "DISCARDED", reasonCode: head.reasonCode };
  }
  if (head.sourceSha !== snapshot.sourceSha || head.sourceRef !== snapshot.sourceRef) {
    const completed = await finishWithoutObservation({
      claim,
      sourceSha: snapshot.sourceSha,
      status: "STALE",
      reasonCode: "SOURCE_DRIFT",
      candidates: result.candidates,
      candidateDigest: result.candidateDigest,
      ...unresolvedProduct,
    }, dependencies);
    if (completed) {
      await enqueueCurrentHead(claim, head.sourceSha, head.defaultBranch, dependencies, {
        private: snapshot.private,
        fork: snapshot.fork,
      });
    }
    return { status: completed ? "STALE" : "DISCARDED", reasonCode: "SOURCE_DRIFT" };
  }

  if (result.status === "EXCLUDED") {
    const completed = await finishWithoutObservation({
      claim,
      sourceSha: snapshot.sourceSha,
      status: "EXCLUDED",
      reasonCode: result.reasonCode,
      candidates: result.candidates,
      candidateDigest: result.candidateDigest,
      managementKind: result.classification === "PLATFORM_PRODUCER"
        ? "PLATFORM_PRODUCER"
        : "UNCLASSIFIED",
      classification: result.classification,
    }, dependencies);
    return { status: completed ? "EXCLUDED" : "DISCARDED", reasonCode: result.reasonCode };
  }
  if (result.status === "NEEDS_INPUT") {
    const completed = await finishWithoutObservation({
      claim,
      sourceSha: snapshot.sourceSha,
      status: "NEEDS_INPUT",
      reasonCode: result.reasonCode,
      candidates: result.candidates,
      candidateDigest: result.candidateDigest,
      ...unresolvedProduct,
    }, dependencies);
    return { status: completed ? "NEEDS_INPUT" : "DISCARDED", reasonCode: result.reasonCode };
  }
  const completed = await finishActive({ claim, snapshot, result }, dependencies);
  return {
    status: completed.completed && !completed.reasonCode ? "MANAGED" : completed.completed ? "NEEDS_INPUT" : "DISCARDED",
    reasonCode: completed.reasonCode,
    observationId: completed.observationId,
  };
}

export async function runRepositoryDiscoveryOnce(
  workerId: string,
  dependencies: RepositoryDiscoveryServiceDependencies = defaultDependencies,
): Promise<{ claimed: boolean; status?: string; reasonCode?: RepositoryDiscoveryReason | null }> {
  await recoverRepositoryDiscoveryRuns(dependencies);
  const claim = await claimRepositoryDiscoveryRun(workerId, dependencies);
  if (!claim) return { claimed: false };
  const result = await processRepositoryDiscoveryClaim(claim, dependencies);
  return { claimed: true, status: result.status, reasonCode: result.reasonCode };
}

export interface RepositoryDiscoveryDrainState {
  registrations: number;
  settled: number;
  queued: number;
  running: number;
  stale: number;
  failed: number;
  missing: number;
}

type RepositoryDiscoveryDrainDependencies = {
  client: typeof prisma;
  runOnce: (workerId: string) => Promise<{ claimed: boolean }>;
  now: () => Date;
  wait: (milliseconds: number) => Promise<void>;
};

const defaultDrainDependencies: RepositoryDiscoveryDrainDependencies = {
  client: prisma,
  runOnce: (workerId) => runRepositoryDiscoveryOnce(workerId),
  now: () => new Date(),
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function readRepositoryDiscoveryDrainState(
  client: typeof prisma = prisma,
): Promise<RepositoryDiscoveryDrainState> {
  const registrations = await client.repositoryRegistration.findMany({
    where: { archived: false },
    select: {
      status: true,
      reconcileGeneration: true,
      discoveryRuns: {
        orderBy: [{ generation: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: { generation: true, status: true },
      },
    },
  });
  const state: RepositoryDiscoveryDrainState = {
    registrations: registrations.length,
    settled: 0,
    queued: 0,
    running: 0,
    stale: 0,
    failed: 0,
    missing: 0,
  };
  for (const registration of registrations) {
    const generation = registration.reconcileGeneration ?? 0;
    const run = registration.discoveryRuns[0];
    if (!run || run.generation !== generation || registration.status === "REGISTERED") {
      state.missing++;
      continue;
    }
    if (run.status === "QUEUED") state.queued++;
    else if (run.status === "RUNNING") state.running++;
    else if (run.status === "STALE") state.stale++;
    else if (run.status === "FAILED") state.failed++;
    else state.settled++;
  }
  return state;
}

/**
 * backfill enqueue와 desired-state DRAFT 생성 사이의 provider readback barrier다.
 * 다른 worker가 claim한 run도 기다리고, source drift가 새 generation으로 이어지지
 * 않은 채 멈추면 성공으로 숨기지 않고 timeout으로 중단한다.
 */
export async function drainRepositoryDiscoveryQueue(
  input: { workerId: string; timeoutMs?: number; pollIntervalMs?: number },
  dependencies: RepositoryDiscoveryDrainDependencies = defaultDrainDependencies,
): Promise<RepositoryDiscoveryDrainState & { claimed: number }> {
  if (!/^[A-Za-z0-9_.:@/-]{1,128}$/.test(input.workerId)) {
    throw new ControlPlaneError("worker ID가 유효하지 않습니다.", 400, "WORKER_ID_INVALID");
  }
  const timeoutMs = input.timeoutMs ?? 780_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 840_000) {
    throw new ControlPlaneError("drain timeout이 유효하지 않습니다.", 400, "DRAIN_TIMEOUT_INVALID");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 10_000) {
    throw new ControlPlaneError("drain poll interval이 유효하지 않습니다.", 400, "DRAIN_POLL_INVALID");
  }
  const deadline = dependencies.now().getTime() + timeoutMs;
  let claimed = 0;
  let consecutiveSettledReads = 0;
  let latest = await readRepositoryDiscoveryDrainState(dependencies.client);
  while (true) {
    if (latest.failed > 0) {
      throw new ControlPlaneError(
        `현재 generation discovery ${latest.failed}건이 실패했습니다.`,
        503,
        "REPOSITORY_DISCOVERY_DRAIN_FAILED",
      );
    }
    const pending = latest.queued + latest.running + latest.stale + latest.missing;
    if (pending === 0) {
      consecutiveSettledReads++;
      if (consecutiveSettledReads >= 2) return { ...latest, claimed };
    } else {
      consecutiveSettledReads = 0;
      const result = await dependencies.runOnce(input.workerId);
      if (result.claimed) claimed++;
    }
    if (dependencies.now().getTime() >= deadline) {
      throw new ControlPlaneError(
        `repository discovery drain이 완료되지 않았습니다: queued=${latest.queued} running=${latest.running} stale=${latest.stale} missing=${latest.missing}`,
        503,
        "REPOSITORY_DISCOVERY_DRAIN_TIMEOUT",
      );
    }
    await dependencies.wait(pollIntervalMs);
    latest = await readRepositoryDiscoveryDrainState(dependencies.client);
  }
}
