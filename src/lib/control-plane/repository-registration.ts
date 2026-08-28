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

export async function registerRepositoryWebhook(input: {
  event: string;
  action?: string;
  repository: RepositoryWebhookInput;
  ref?: string;
  after?: string;
  deliveryId: string;
  organization: string;
}, dependencies: RepositoryRegistrationDependencies = defaultDependencies): Promise<{
  duplicate: boolean;
  enqueued: boolean;
  runId: string | null;
  generation: number | null;
}> {
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
  const now = dependencies.now();
  const requestHash = jsonDigest({
    event: input.event,
    action: input.action ?? null,
    repoId: repoId.toString(),
    repoFullName: repo.full_name,
    defaultBranch: repo.default_branch ?? null,
    archived,
    sourceSha: trigger.sourceSha,
    sourceRef: trigger.sourceRef,
  } as JsonValue);

  return dependencies.client.$transaction(async (tx) => {
    const existingRun = await tx.repositoryDiscoveryRun.findUnique({
      where: { triggerDeliveryId: input.deliveryId },
      select: { id: true, generation: true, requestHash: true },
    });
    if (existingRun) {
      if (existingRun.requestHash !== requestHash) {
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
    const app = await tx.app.findUnique({ where: { repoId }, select: { id: true } });
    const status = registrationStatus({ archived, managed: Boolean(app) });
    await tx.repositoryRegistration.upsert({
      where: { repoId },
      create: {
        repoId,
        repoFullName: repo.full_name,
        defaultBranch: repo.default_branch ?? null,
        archived,
        status,
        managementKind: "UNCLASSIFIED",
        reconcileGeneration: 0,
        lastDefaultPushSha: trigger.sourceSha,
        lastDeliveryId: input.deliveryId,
      },
      update: {
        repoFullName: repo.full_name,
        defaultBranch: repo.default_branch ?? undefined,
        archived,
        status,
        ...(trigger.sourceSha ? { lastDefaultPushSha: trigger.sourceSha } : {}),
        lastDeliveryId: input.deliveryId,
      },
    });
    await tx.$queryRaw`SELECT repoId FROM repository_registration WHERE repoId = ${repoId} FOR UPDATE`;

    if (archived) {
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
          },
        },
      });
      return { duplicate: false, enqueued: false, runId: null, generation: null };
    }

    if (!trigger.relevant) {
      return { duplicate: false, enqueued: false, runId: null, generation: null };
    }

    const registration = await tx.repositoryRegistration.findUniqueOrThrow({
      where: { repoId },
      select: { reconcileGeneration: true },
    });
    const currentGeneration = registration.reconcileGeneration ?? 0;
    const semanticReplay = await tx.repositoryDiscoveryRun.findFirst({
      where: {
        repoId,
        generation: currentGeneration,
        requestHash,
        status: { in: ["QUEUED", "RUNNING", "MANAGED", "NEEDS_INPUT", "EXCLUDED"] },
      },
      select: { id: true, generation: true },
    });
    if (semanticReplay) {
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
        status: app ? "MANAGED" : "REGISTERED",
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
  });
}
