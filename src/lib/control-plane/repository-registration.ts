import type { RepositoryRegistrationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface RepositoryWebhookInput {
  id: number;
  full_name: string;
  name?: string;
  default_branch?: string | null;
  archived?: boolean;
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

export async function registerRepositoryWebhook(input: {
  event: string;
  action?: string;
  repository: RepositoryWebhookInput;
  ref?: string;
  after?: string;
  deliveryId: string;
  organization: string;
}): Promise<void> {
  const repo = input.repository;
  if (!Number.isSafeInteger(repo.id) || repo.id <= 0) return;
  if (!repo.full_name.startsWith(`${input.organization}/`)) return;
  const repoId = BigInt(repo.id);
  const app = await prisma.app.findUnique({ where: { repoId }, select: { id: true } });
  const archived = repo.archived === true || input.action === "archived";
  const status = registrationStatus({ archived, managed: Boolean(app) });
  const isDefaultPush = input.event === "push"
    && Boolean(repo.default_branch)
    && input.ref === `refs/heads/${repo.default_branch}`
    && /^[0-9a-f]{40}$/i.test(input.after ?? "");

  await prisma.$transaction(async (tx) => {
    await tx.repositoryRegistration.upsert({
      where: { repoId },
      create: {
        repoId,
        repoFullName: repo.full_name,
        defaultBranch: repo.default_branch ?? null,
        archived,
        status,
        lastDefaultPushSha: isDefaultPush ? input.after!.toLowerCase() : null,
        lastDeliveryId: input.deliveryId,
      },
      update: {
        repoFullName: repo.full_name,
        defaultBranch: repo.default_branch ?? undefined,
        archived,
        status,
        ...(isDefaultPush ? { lastDefaultPushSha: input.after!.toLowerCase() } : {}),
        lastDeliveryId: input.deliveryId,
      },
    });
    if (app && input.event === "repository" && input.action === "renamed") {
      await tx.app.update({
        where: { id: app.id },
        data: {
          repoFullName: repo.full_name,
          slug: repo.name ?? repo.full_name.split("/").at(-1)!,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        action: `control-plane.repository.${input.event}.${input.action ?? "default"}`,
        entityType: "RepositoryRegistration",
        entityId: repoId.toString(),
        payload: {
          repoFullName: repo.full_name,
          defaultBranch: repo.default_branch ?? null,
          archived,
          isDefaultPush,
          deliveryId: input.deliveryId,
        },
      },
    });
  });
}

