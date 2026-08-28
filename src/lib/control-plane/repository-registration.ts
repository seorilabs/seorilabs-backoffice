import { Prisma, type RepositoryRegistrationStatus } from "@prisma/client";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";

const SHA_40 = /^[0-9a-f]{40}$/i;
const REPOSITORY_DISCOVERY_ACTIONS = new Set([
  "created",
  "renamed",
  "unarchived",
  "edited",
]);

export interface RepositoryWebhookInput {
  id: number;
  full_name: string;
  name?: string;
  default_branch?: string | null;
  archived?: boolean;
  private?: boolean;
}

export function registrationStatus(input: {
  archived: boolean;
  managed: boolean;
  candidateCount?: number;
}): RepositoryRegistrationStatus {
  if (input.archived) return "ARCHIVED";
  if (input.managed) return "MANAGED";
  if (input.candidateCount !== undefined && input.candidateCount !== 1) return "NEEDS_INPUT";
  return "REGISTERED";
}

export function repositorySourceIsCurrent(input: {
  archived: boolean;
  status: string;
  managementKind: string | null;
  lastDefaultPushSha: string | null;
  lastReconciledSha: string | null;
}, observationSha?: string | null): boolean {
  if (input.archived || input.status !== "MANAGED") return false;
  if (input.managementKind !== "APP") return false;
  const pushed = input.lastDefaultPushSha?.toLowerCase() ?? null;
  const reconciled = input.lastReconciledSha?.toLowerCase() ?? null;
  return pushed !== null
    && pushed === reconciled
    && (observationSha === undefined || observationSha?.toLowerCase() === pushed);
}

export function repositoryAutomationEligible(input: Parameters<typeof repositorySourceIsCurrent>[0] | null): boolean {
  return input !== null && repositorySourceIsCurrent(input);
}

export function repositoryGenerationAfterArchive(input: {
  archived: boolean;
  reconcileGeneration: number | null;
}): number {
  const current = input.reconcileGeneration ?? 0;
  return input.archived ? current : current + 1;
}

export function repositoryDiscoveryTrigger(input: {
  event: string;
  action?: string;
  defaultBranch?: string | null;
  ref?: string;
  after?: string;
}): { relevant: boolean; sourceSha: string | null; sourceRef: string | null } {
  const sourceRef = input.defaultBranch ? `refs/heads/${input.defaultBranch}` : null;
  if (input.event === "reconcile") {
    return {
      relevant: true,
      sourceSha: SHA_40.test(input.after ?? "") ? input.after!.toLowerCase() : null,
      sourceRef,
    };
  }
  if (input.event === "push") {
    const isDefaultPush = Boolean(sourceRef) && input.ref === sourceRef;
    return {
      relevant: isDefaultPush,
      sourceSha: isDefaultPush && SHA_40.test(input.after ?? "")
        ? input.after!.toLowerCase()
        : null,
      sourceRef,
    };
  }
  return {
    relevant: input.event === "repository" && REPOSITORY_DISCOVERY_ACTIONS.has(input.action ?? ""),
    sourceSha: null,
    sourceRef,
  };
}

type RepositoryRegistrationDependencies = {
  client: typeof prisma;
  now: () => Date;
};

const defaultDependencies: RepositoryRegistrationDependencies = {
  client: prisma,
  now: () => new Date(),
};

export type RegisterRepositoryWebhookInput = {
  event: string;
  action?: string;
  repository: RepositoryWebhookInput;
  ref?: string;
  after?: string;
  deliveryId: string;
  organization: string;
};

export function repositoryDiscoveryRequestHashes(
  input: RegisterRepositoryWebhookInput,
  archived: boolean,
  trigger: ReturnType<typeof repositoryDiscoveryTrigger>,
): { current: string; legacyV1: string } {
  const common = {
    event: input.event,
    action: input.action ?? null,
    repoId: String(input.repository.id),
    repoFullName: input.repository.full_name,
    defaultBranch: input.repository.default_branch ?? null,
    archived,
    sourceSha: trigger.sourceSha,
    sourceRef: trigger.sourceRef,
  } as const;
  return {
    current: jsonDigest({
      ...common,
      private: input.repository.private ?? null,
    } as JsonValue),
    // 2026-08-28 이전 persisted delivery의 redelivery만 받아들이는 bounded
    // compatibility다. 새 row에는 항상 private을 포함한 current hash를 저장한다.
    legacyV1: jsonDigest(common as JsonValue),
  };
}

export function repositoryDiscoveryRequestHashMatches(
  stored: string,
  hashes: ReturnType<typeof repositoryDiscoveryRequestHashes>,
): boolean {
  return stored === hashes.current || stored === hashes.legacyV1;
}

type RegisterRepositoryWebhookResult = {
  duplicate: boolean;
  enqueued: boolean;
  runId: string | null;
  generation: number | null;
};

/**
 * provider readback 전에는 webhook의 rename/archive/SHA를 정본으로 쓰지 않는다.
 * 대신 기존 generation을 즉시 폐기하고 REGISTERED로 내려 새 claim/parity를 막는다.
 */
export async function invalidateRepositoryDiscoveryInTransaction(
  input: RegisterRepositoryWebhookInput,
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<void> {
  const repo = input.repository;
  if (
    !Number.isSafeInteger(repo.id)
    || repo.id <= 0
    || !repo.full_name.startsWith(`${input.organization}/`)
  ) return;
  const repoId = BigInt(repo.id);
  const trigger = repositoryDiscoveryTrigger({
    event: input.event,
    action: input.action,
    defaultBranch: repo.default_branch,
    ref: input.ref,
    after: input.after,
  });
  const archived = repo.archived === true || input.action === "archived" || input.action === "deleted";
  if (!trigger.relevant && !archived) return;
  await tx.repositoryRegistration.upsert({
    where: { repoId },
    create: {
      repoId,
      repoFullName: repo.full_name,
      defaultBranch: repo.default_branch ?? null,
      archived: false,
      status: "REGISTERED",
      managementKind: "UNCLASSIFIED",
      reconcileGeneration: 0,
    },
    update: {
      status: "REGISTERED",
    },
  });
  await tx.$executeRaw`
    UPDATE repository_registration
    SET reconcileGeneration = COALESCE(reconcileGeneration, 0) + 1
    WHERE repoId = ${repoId}
  `;
  await tx.$queryRaw`SELECT repoId FROM repository_registration WHERE repoId = ${repoId} FOR UPDATE`;
  await tx.repositoryDiscoveryRun.updateMany({
    where: { repoId, status: { in: ["QUEUED", "RUNNING"] } },
    data: {
      status: "STALE",
      reasonCode: "SOURCE_DRIFT",
      workerId: null,
      leaseExpiresAt: null,
      completedAt: now,
    },
  });
}

export async function registerRepositoryWebhookInTransaction(
  input: RegisterRepositoryWebhookInput,
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<RegisterRepositoryWebhookResult> {
  const repo = input.repository;
  if (!Number.isSafeInteger(repo.id) || repo.id <= 0) {
    return { duplicate: false, enqueued: false, runId: null, generation: null };
  }
  if (!repo.full_name.startsWith(`${input.organization}/`)) {
    return { duplicate: false, enqueued: false, runId: null, generation: null };
  }
  const repoId = BigInt(repo.id);
  const archived = repo.archived === true || input.action === "archived" || input.action === "deleted";
  const trigger = repositoryDiscoveryTrigger({
    event: input.event,
    action: input.action,
    defaultBranch: repo.default_branch,
    ref: input.ref,
    after: input.after,
  });
  const requestHashes = repositoryDiscoveryRequestHashes(input, archived, trigger);
  const requestHash = requestHashes.current;

  const existingRun = await tx.repositoryDiscoveryRun.findUnique({
      where: { triggerDeliveryId: input.deliveryId },
      select: { id: true, generation: true, requestHash: true },
    });
    if (existingRun) {
      if (!repositoryDiscoveryRequestHashMatches(existingRun.requestHash, requestHashes)) {
        throw new Error("REPOSITORY_DISCOVERY_DELIVERY_CONFLICT");
      }
      return {
        duplicate: true,
        enqueued: true,
        runId: existingRun.id,
        generation: existingRun.generation,
      };
    }
    const current = await tx.repositoryRegistration.findUnique({
      where: { repoId },
      select: { lastDeliveryId: true },
    });
    if (current?.lastDeliveryId === input.deliveryId) {
      return { duplicate: true, enqueued: false, runId: null, generation: null };
    }
    await tx.repositoryRegistration.upsert({
      where: { repoId },
      create: {
        repoId,
        repoFullName: repo.full_name,
        defaultBranch: repo.default_branch ?? null,
        archived,
        status: archived ? "ARCHIVED" : "REGISTERED",
        managementKind: "UNCLASSIFIED",
        reconcileGeneration: 0,
        lastDefaultPushSha: trigger.sourceSha,
        lastDeliveryId: input.deliveryId,
      },
      update: {
        repoFullName: repo.full_name,
        ...(Object.prototype.hasOwnProperty.call(repo, "default_branch")
          ? { defaultBranch: repo.default_branch ?? null }
          : {}),
        // tag/non-default push가 NEEDS_INPUT 또는 EXCLUDED 판정을 지우지 않는다.
        // relevant generation은 아래에서만 REGISTERED로 전환한다.
        ...(trigger.sourceSha ? { lastDefaultPushSha: trigger.sourceSha } : {}),
        lastDeliveryId: input.deliveryId,
      },
    });
    await tx.$queryRaw`SELECT repoId FROM repository_registration WHERE repoId = ${repoId} FOR UPDATE`;
    const registration = await tx.repositoryRegistration.findUniqueOrThrow({
      where: { repoId },
      select: { archived: true, reconcileGeneration: true },
    });

    if (archived) {
      const generation = repositoryGenerationAfterArchive(registration);
      await tx.repositoryRegistration.update({
        where: { repoId },
        data: {
          archived: true,
          status: "ARCHIVED",
          reconcileGeneration: generation,
        },
      });
      await tx.repositoryDiscoveryRun.updateMany({
        where: { repoId, status: { in: ["QUEUED", "RUNNING"] } },
        data: {
          status: "STALE",
          reasonCode: "ARCHIVED",
          workerId: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          action: `control-plane.repository.${input.event}.${input.action ?? "default"}`,
          entityType: "RepositoryRegistration",
          entityId: repoId.toString(),
          payload: {
            repoFullName: repo.full_name,
            archived: true,
            deliveryId: input.deliveryId,
            discoveryEnqueued: false,
            generation,
          },
        },
      });
      return { duplicate: false, enqueued: false, runId: null, generation: null };
    }

    if (!trigger.relevant) {
      return { duplicate: false, enqueued: false, runId: null, generation: null };
    }

    if (registration.archived) {
      await tx.repositoryRegistration.update({
        where: { repoId },
        data: { archived: false },
      });
    }
    const currentGeneration = registration.reconcileGeneration ?? 0;
    const semanticReplay = await tx.repositoryDiscoveryRun.findFirst({
      where: {
        repoId,
        generation: currentGeneration,
        requestHash,
        status: { in: ["QUEUED", "RUNNING", "MANAGED", "NEEDS_INPUT", "EXCLUDED"] },
      },
      select: { id: true, generation: true, status: true },
    });
    if (semanticReplay) {
      if (semanticReplay.status === "QUEUED" || semanticReplay.status === "RUNNING") {
        await tx.repositoryRegistration.update({
          where: { repoId },
          data: { status: "REGISTERED" },
        });
      }
      return {
        duplicate: true,
        enqueued: true,
        runId: semanticReplay.id,
        generation: semanticReplay.generation,
      };
    }
    const generation = currentGeneration + 1;
    await tx.repositoryDiscoveryRun.updateMany({
      where: { repoId, status: { in: ["QUEUED", "RUNNING"] } },
      data: {
        status: "STALE",
        reasonCode: "SOURCE_DRIFT",
        workerId: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    });
    await tx.repositoryRegistration.update({
      where: { repoId },
      data: {
        reconcileGeneration: generation,
        managementKind: "UNCLASSIFIED",
        discoveryCandidates: Prisma.DbNull,
        lastDiscoveryReason: null,
        // 기존 App도 새 generation이 exact HEAD로 완료되기 전에는 자동화와
        // parity에서 current로 취급하지 않는다.
        status: "REGISTERED",
      },
    });
    const run = await tx.repositoryDiscoveryRun.create({
      data: {
        repoId,
        generation,
        triggerDeliveryId: input.deliveryId,
        requestHash,
        sourceSha: trigger.sourceSha,
        sourceRef: trigger.sourceRef,
        availableAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        action: `control-plane.repository.${input.event}.${input.action ?? "default"}`,
        entityType: "RepositoryDiscoveryRun",
        entityId: run.id,
        payload: {
          repoId: repoId.toString(),
          repoFullName: repo.full_name,
          sourceSha: trigger.sourceSha,
          sourceRef: trigger.sourceRef,
          deliveryId: input.deliveryId,
          generation,
        },
      },
    });
  return { duplicate: false, enqueued: true, runId: run.id, generation };
}

export async function registerRepositoryWebhook(
  input: RegisterRepositoryWebhookInput,
  dependencies: RepositoryRegistrationDependencies = defaultDependencies,
): Promise<RegisterRepositoryWebhookResult> {
  const now = dependencies.now();
  return dependencies.client.$transaction((tx) => (
    registerRepositoryWebhookInTransaction(input, tx, now)
  ));
}
