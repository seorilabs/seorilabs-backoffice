import { Prisma, type FleetProjectBinding as FleetProjectBindingRow } from "@prisma/client";
import { z } from "zod";

import {
  automationMutationIdentityMatches,
  automationMutationRequestHash,
} from "@/lib/control-plane/automation-mutation";
import { fleetProjectPermissionDisposition } from "@/lib/control-plane/fleet-project-permission";
import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import type { InstallationContext } from "@/lib/github/app";
import { prisma } from "@/lib/prisma";

export const FLEET_PROJECT_BINDING_ID = "seorilabs-fleet" as const;
export const FLEET_PROJECT_EXPECTED_TITLE = "Seorilabs Fleet" as const;
export const FLEET_PROJECT_UNCONFIGURED_ID = "UNCONFIGURED:SEORILABS_FLEET" as const;

const organizationLogin = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);

export const fleetProjectBindingDesiredStateSchema = z.object({
  organizationLogin,
  projectNumber: z.number().int().positive().max(1_000_000),
  expectedRevision: z.number().int().min(0),
}).strict();

export type FleetProjectBindingDesiredState = z.infer<typeof fleetProjectBindingDesiredStateSchema>;

type PublicFleetProjectBinding = {
  id: typeof FLEET_PROJECT_BINDING_ID;
  organizationLogin: string;
  projectNumber: number;
  expectedTitle: typeof FLEET_PROJECT_EXPECTED_TITLE;
  revision: number;
  projectNodeId: string | null;
  observedProjectNodeId: string | null;
  organizationNodeId: string | null;
  observedTitle: string | null;
  observedUrl: string | null;
  permissionLevel: string | null;
  missingRequirements: string[];
  status: FleetProjectBindingRow["status"];
  lastErrorCode: string | null;
  lastError: string | null;
  observedAt: string | null;
  verifiedAt: string | null;
};

function stringArray(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function publicFleetProjectBinding(
  row: FleetProjectBindingRow,
): PublicFleetProjectBinding {
  return {
    id: FLEET_PROJECT_BINDING_ID,
    organizationLogin: row.organizationLogin,
    projectNumber: row.projectNumber,
    expectedTitle: FLEET_PROJECT_EXPECTED_TITLE,
    revision: row.revision,
    projectNodeId: row.projectNodeId,
    observedProjectNodeId: row.observedProjectNodeId,
    organizationNodeId: row.organizationNodeId,
    observedTitle: row.observedTitle,
    observedUrl: row.observedUrl,
    permissionLevel: row.permissionLevel,
    missingRequirements: stringArray(row.missingRequirements),
    status: row.status,
    lastErrorCode: row.lastErrorCode,
    lastError: row.lastError,
    observedAt: row.observedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  };
}

export async function getFleetProjectBinding(): Promise<PublicFleetProjectBinding | null> {
  const row = await prisma.fleetProjectBinding.findUnique({
    where: { id: FLEET_PROJECT_BINDING_ID },
  });
  return row ? publicFleetProjectBinding(row) : null;
}

function desiredStateMatches(
  row: FleetProjectBindingRow,
  desired: FleetProjectBindingDesiredState,
): boolean {
  return row.organizationLogin.toLowerCase() === desired.organizationLogin.toLowerCase()
    && row.projectNumber === desired.projectNumber
    && row.expectedTitle === FLEET_PROJECT_EXPECTED_TITLE;
}

export async function setFleetProjectBindingDesiredState(input: {
  desired: FleetProjectBindingDesiredState;
  actor: string;
  idempotencyKey: string;
  expectedOrganization?: string;
}): Promise<{ duplicate: boolean; changed: boolean; binding: PublicFleetProjectBinding }> {
  const desired = fleetProjectBindingDesiredStateSchema.parse(input.desired);
  const expectedOrganization = input.expectedOrganization
    ?? process.env.GITHUB_ORG?.trim()
    ?? "seorilabs";
  if (desired.organizationLogin.toLowerCase() !== expectedOrganization.toLowerCase()) {
    throw new ControlPlaneError(
      "Fleet Project owner가 configured GitHub organization과 일치하지 않습니다.",
      409,
      "FLEET_PROJECT_ORGANIZATION_MISMATCH",
    );
  }
  const request = {
    organizationLogin: desired.organizationLogin,
    projectNumber: desired.projectNumber,
    expectedRevision: desired.expectedRevision,
  } satisfies JsonValue;
  const mutationIdentity = {
    requestId: input.idempotencyKey,
    actor: input.actor,
    operation: "FLEET_PROJECT_BINDING_SET",
    targetKey: `fleet-project:${FLEET_PROJECT_BINDING_ID}`,
    request,
  } as const;
  const requestHash = automationMutationRequestHash(mutationIdentity);

  try {
    return await prisma.$transaction(async (tx) => {
      const inserted = await tx.automationMutationRequest.createMany({
        data: [{
          requestId: input.idempotencyKey,
          actor: input.actor,
          operation: mutationIdentity.operation,
          targetKey: mutationIdentity.targetKey,
          requestHash,
          request: request as Prisma.InputJsonValue,
        }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        const replay = await tx.automationMutationRequest.findUnique({
          where: { requestId: input.idempotencyKey },
        });
        if (!replay || !automationMutationIdentityMatches(replay, mutationIdentity, requestHash)) {
          throw new ControlPlaneError(
            "idempotency key가 다른 Fleet Project binding 요청에 사용되었습니다.",
            409,
            "IDEMPOTENCY_CONFLICT",
          );
        }
        if (replay.status === "COMPLETED" && replay.response !== null) {
          const response = replay.response as unknown as {
            changed: boolean;
            binding: PublicFleetProjectBinding;
          };
          return { duplicate: true, changed: response.changed, binding: response.binding };
        }
        throw new ControlPlaneError(
          "같은 Fleet Project binding 요청이 아직 처리 중입니다.",
          409,
          "MUTATION_IN_PROGRESS",
        );
      }

      const current = await tx.fleetProjectBinding.findUnique({
        where: { id: FLEET_PROJECT_BINDING_ID },
      });
      const actualRevision = current?.revision ?? 0;
      if (actualRevision !== desired.expectedRevision) {
        throw new ControlPlaneError(
          `Fleet Project binding revision 충돌: expected=${desired.expectedRevision}, actual=${actualRevision}`,
          409,
          "FLEET_PROJECT_BINDING_REVISION_CONFLICT",
        );
      }
      const changed = current === null || !desiredStateMatches(current, desired);
      let binding: FleetProjectBindingRow;
      if (!current) {
        binding = await tx.fleetProjectBinding.create({
          data: {
            id: FLEET_PROJECT_BINDING_ID,
            organizationLogin: desired.organizationLogin,
            projectNumber: desired.projectNumber,
            expectedTitle: FLEET_PROJECT_EXPECTED_TITLE,
            revision: 1,
            createdBy: input.actor,
            updatedBy: input.actor,
          },
        });
      } else if (changed) {
        const updated = await tx.fleetProjectBinding.updateMany({
          where: { id: FLEET_PROJECT_BINDING_ID, revision: desired.expectedRevision },
          data: {
            organizationLogin: desired.organizationLogin,
            projectNumber: desired.projectNumber,
            expectedTitle: FLEET_PROJECT_EXPECTED_TITLE,
            revision: { increment: 1 },
            projectNodeId: null,
            observedProjectNodeId: null,
            organizationNodeId: null,
            observedTitle: null,
            observedUrl: null,
            permissionLevel: null,
            missingRequirements: Prisma.DbNull,
            status: "PENDING",
            lastErrorCode: null,
            lastError: null,
            observedAt: null,
            verifiedAt: null,
            updatedBy: input.actor,
          },
        });
        if (updated.count !== 1) {
          throw new ControlPlaneError(
            "Fleet Project binding optimistic concurrency 검사에 실패했습니다.",
            409,
            "FLEET_PROJECT_BINDING_REVISION_CONFLICT",
          );
        }
        await tx.fleetProjectProjection.updateMany({
          where: { status: { not: "SUPERSEDED" } },
          data: {
            status: "SUPERSEDED",
            lastError: "조직 Fleet Project desired-state revision이 변경되었습니다.",
          },
        });
        binding = await tx.fleetProjectBinding.findUniqueOrThrow({
          where: { id: FLEET_PROJECT_BINDING_ID },
        });
      } else {
        binding = current;
      }

      const response = {
        changed,
        binding: publicFleetProjectBinding(binding),
      };
      const completed = await tx.automationMutationRequest.updateMany({
        where: {
          requestId: input.idempotencyKey,
          requestHash,
          status: "PENDING",
        },
        data: {
          status: "COMPLETED",
          response: response as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      if (completed.count !== 1) {
        throw new ControlPlaneError(
          "Fleet Project binding mutation 완료 CAS에 실패했습니다.",
          409,
          "MUTATION_CAS_CONFLICT",
        );
      }
      await tx.auditLog.create({
        data: {
          actorLogin: input.actor,
          action: "control-plane.fleet-project-binding.set",
          entityType: "FleetProjectBinding",
          entityId: FLEET_PROJECT_BINDING_ID,
          payload: {
            requestId: input.idempotencyKey,
            organizationLogin: desired.organizationLogin,
            projectNumber: desired.projectNumber,
            revision: binding.revision,
            changed,
          },
        },
      });
      return { duplicate: false, changed, binding: response.binding };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ControlPlaneError(
        "Fleet Project binding optimistic concurrency 검사에 실패했습니다.",
        409,
        "FLEET_PROJECT_BINDING_REVISION_CONFLICT",
      );
    }
    throw error;
  }
}

interface FleetProjectIdentityQuery {
  organization: null | {
    id: string;
    login: string;
    projectV2: null | {
      id: string;
      number: number;
      title: string;
      url: string;
      closed: boolean;
    };
  };
}

const FLEET_PROJECT_IDENTITY_QUERY = `
  query SeorilabsFleetProjectIdentity($organization: String!, $number: Int!) {
    organization(login: $organization) {
      id
      login
      projectV2(number: $number) {
        id
        number
        title
        url
        closed
      }
    }
  }
`;

function githubPermissionFailure(error: unknown): boolean {
  const candidate = error as {
    status?: unknown;
    errors?: Array<{ type?: unknown }>;
    response?: { errors?: Array<{ type?: unknown }> };
  };
  if (candidate?.status === 401 || candidate?.status === 403) return true;
  const errors = candidate?.errors ?? candidate?.response?.errors ?? [];
  return errors.some((item) => (
    item.type === "FORBIDDEN"
    || item.type === "INSUFFICIENT_SCOPES"
    || item.type === "UNAUTHORIZED"
  ));
}

function expectedProjectUrl(organization: string, projectNumber: number): string {
  return `https://github.com/orgs/${organization}/projects/${projectNumber}`;
}

function publicIdentityMismatch(input: {
  binding: FleetProjectBindingRow;
  organization: NonNullable<FleetProjectIdentityQuery["organization"]>;
}): { code: string; message: string } | null {
  const project = input.organization.projectV2;
  if (!project) {
    return {
      code: "FLEET_PROJECT_NOT_FOUND",
      message: "승인된 organization Projects 권한으로 Seorilabs Fleet Project를 찾을 수 없습니다.",
    };
  }
  if (
    input.organization.login.toLowerCase() !== input.binding.organizationLogin.toLowerCase()
    || project.number !== input.binding.projectNumber
    || project.title !== input.binding.expectedTitle
    || project.url !== expectedProjectUrl(input.organization.login, project.number)
    || project.closed
  ) {
    return {
      code: "FLEET_PROJECT_PUBLIC_IDENTITY_MISMATCH",
      message: "GitHub Project의 공개 owner, number, title, URL 또는 open 상태가 desired state와 다릅니다.",
    };
  }
  if (input.binding.projectNodeId && input.binding.projectNodeId !== project.id) {
    return {
      code: "FLEET_PROJECT_NODE_ID_DRIFT",
      message: "검증된 Fleet Project node ID가 변경되어 자동 projection을 중단했습니다.",
    };
  }
  return null;
}

type FleetProjectObservationUpdate = {
  status: FleetProjectBindingRow["status"];
  projectNodeId?: string | null;
  observedProjectNodeId?: string | null;
  organizationNodeId?: string | null;
  observedTitle?: string | null;
  observedUrl?: string | null;
  permissionLevel: string | null;
  missingRequirements: string[];
  lastErrorCode: string | null;
  lastError: string | null;
  verifiedAt?: Date | null;
};

async function recordFleetProjectObservation(input: {
  binding: FleetProjectBindingRow;
  observation: FleetProjectObservationUpdate;
  actor: string;
  observedAt: Date;
}): Promise<FleetProjectBindingRow> {
  const previousMissing = stringArray(input.binding.missingRequirements);
  const meaningfulChanged = input.binding.status !== input.observation.status
    || input.binding.projectNodeId !== (input.observation.projectNodeId ?? input.binding.projectNodeId)
    || input.binding.observedProjectNodeId !== (input.observation.observedProjectNodeId ?? null)
    || input.binding.organizationNodeId !== (input.observation.organizationNodeId ?? null)
    || input.binding.observedTitle !== (input.observation.observedTitle ?? null)
    || input.binding.observedUrl !== (input.observation.observedUrl ?? null)
    || input.binding.permissionLevel !== input.observation.permissionLevel
    || canonicalJson(previousMissing as JsonValue) !== canonicalJson(input.observation.missingRequirements as JsonValue)
    || input.binding.lastErrorCode !== input.observation.lastErrorCode;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.fleetProjectBinding.updateMany({
      where: {
        id: FLEET_PROJECT_BINDING_ID,
        revision: input.binding.revision,
        OR: [
          { observedAt: null },
          { observedAt: { lte: input.observedAt } },
        ],
      },
      data: {
        status: input.observation.status,
        ...(input.observation.projectNodeId !== undefined
          ? { projectNodeId: input.observation.projectNodeId }
          : {}),
        observedProjectNodeId: input.observation.observedProjectNodeId ?? null,
        organizationNodeId: input.observation.organizationNodeId ?? null,
        observedTitle: input.observation.observedTitle ?? null,
        observedUrl: input.observation.observedUrl ?? null,
        permissionLevel: input.observation.permissionLevel,
        missingRequirements: input.observation.missingRequirements.length > 0
          ? input.observation.missingRequirements
          : Prisma.DbNull,
        lastErrorCode: input.observation.lastErrorCode,
        lastError: input.observation.lastError,
        observedAt: input.observedAt,
        ...(input.observation.verifiedAt !== undefined
          ? { verifiedAt: input.observation.verifiedAt }
          : {}),
        updatedBy: input.actor,
      },
    });
    if (updated.count !== 1) {
      const latest = await tx.fleetProjectBinding.findUnique({
        where: { id: FLEET_PROJECT_BINDING_ID },
      });
      if (
        latest
        && latest.revision === input.binding.revision
        && latest.observedAt
        && latest.observedAt > input.observedAt
      ) {
        return latest;
      }
      throw new ControlPlaneError(
        "Fleet Project binding readback CAS에 실패했습니다.",
        409,
        "FLEET_PROJECT_BINDING_CAS_FAILED",
      );
    }
    if (meaningfulChanged) {
      await tx.auditLog.create({
        data: {
          actorLogin: input.actor,
          action: "control-plane.fleet-project-binding.observe",
          entityType: "FleetProjectBinding",
          entityId: FLEET_PROJECT_BINDING_ID,
          payload: {
            revision: input.binding.revision,
            status: input.observation.status,
            errorCode: input.observation.lastErrorCode,
            missingRequirements: input.observation.missingRequirements,
          },
        },
      });
    }
    return tx.fleetProjectBinding.findUniqueOrThrow({
      where: { id: FLEET_PROJECT_BINDING_ID },
    });
  });
}

export interface FleetProjectBindingReconcileDependencies {
  getInstallationContext: () => Promise<InstallationContext>;
  now: () => Date;
}

const defaultReconcileDependencies: FleetProjectBindingReconcileDependencies = {
  getInstallationContext: async () => {
    const { getInstallationContext } = await import("@/lib/github/app");
    return getInstallationContext({ forceRefresh: true });
  },
  now: () => new Date(),
};

export async function reconcileFleetProjectBinding(
  dependencies: FleetProjectBindingReconcileDependencies = defaultReconcileDependencies,
): Promise<{
  gate: "VERIFIED" | "NEEDS_INPUT" | "HUMAN_PERMISSION_REQUIRED" | "READBACK_REQUIRED" | "IDENTITY_MISMATCH";
  binding: PublicFleetProjectBinding | null;
}> {
  const binding = await prisma.fleetProjectBinding.findUnique({
    where: { id: FLEET_PROJECT_BINDING_ID },
  });
  if (!binding) return { gate: "NEEDS_INPUT", binding: null };
  const observedAt = dependencies.now();
  let context: InstallationContext;
  try {
    context = await dependencies.getInstallationContext();
  } catch {
    const updated = await recordFleetProjectObservation({
      binding,
      actor: "scheduler:fleet-project-binding",
      observedAt,
      observation: {
        status: "READBACK_REQUIRED",
        permissionLevel: null,
        missingRequirements: ["installation:readback-required"],
        lastErrorCode: "GITHUB_APP_INSTALLATION_READBACK_REQUIRED",
        lastError: "GitHub App installation 공개 상태를 읽지 못해 Project 존재 여부를 판정하지 않았습니다.",
      },
    });
    return { gate: "READBACK_REQUIRED", binding: publicFleetProjectBinding(updated) };
  }
  const permission = fleetProjectPermissionDisposition(
    context.publicState,
    binding.organizationLogin,
  );
  if (permission.kind !== "GRANTED") {
    const updated = await recordFleetProjectObservation({
      binding,
      actor: "scheduler:fleet-project-binding",
      observedAt,
      observation: {
        status: "HUMAN_PERMISSION_REQUIRED",
        permissionLevel: permission.permissionLevel,
        missingRequirements: permission.missingRequirements,
        lastErrorCode: permission.errorCode,
        lastError: permission.message,
      },
    });
    return { gate: "HUMAN_PERMISSION_REQUIRED", binding: publicFleetProjectBinding(updated) };
  }

  let response: FleetProjectIdentityQuery;
  try {
    response = await context.octokit.graphql<FleetProjectIdentityQuery>(
      FLEET_PROJECT_IDENTITY_QUERY,
      { organization: binding.organizationLogin, number: binding.projectNumber },
    );
  } catch (error) {
    const permissionFailure = githubPermissionFailure(error);
    const updated = await recordFleetProjectObservation({
      binding,
      actor: "scheduler:fleet-project-binding",
      observedAt,
      observation: {
        status: permissionFailure ? "HUMAN_PERMISSION_REQUIRED" : "READBACK_REQUIRED",
        permissionLevel: permission.permissionLevel,
        missingRequirements: permissionFailure
          ? ["permission:organization_projects:write"]
          : ["project:readback-required"],
        lastErrorCode: permissionFailure
          ? "GITHUB_ORG_PROJECTS_WRITE_PERMISSION_REQUIRED"
          : "FLEET_PROJECT_READBACK_REQUIRED",
        lastError: permissionFailure
          ? "GitHub App token이 organization Projects query를 거부했습니다. 설치 권한 재승인이 필요합니다."
          : "GitHub Project 공개 identity readback을 완료하지 못했습니다.",
      },
    });
    return {
      gate: permissionFailure ? "HUMAN_PERMISSION_REQUIRED" : "READBACK_REQUIRED",
      binding: publicFleetProjectBinding(updated),
    };
  }

  const organization = response.organization;
  if (!organization) {
    const updated = await recordFleetProjectObservation({
      binding,
      actor: "scheduler:fleet-project-binding",
      observedAt,
      observation: {
        status: "IDENTITY_MISMATCH",
        permissionLevel: permission.permissionLevel,
        missingRequirements: [],
        lastErrorCode: "FLEET_PROJECT_ORGANIZATION_NOT_FOUND",
        lastError: "승인된 organization Projects 권한으로 desired owner organization을 찾을 수 없습니다.",
      },
    });
    return { gate: "IDENTITY_MISMATCH", binding: publicFleetProjectBinding(updated) };
  }
  const mismatch = publicIdentityMismatch({ binding, organization });
  if (mismatch) {
    const updated = await recordFleetProjectObservation({
      binding,
      actor: "scheduler:fleet-project-binding",
      observedAt,
      observation: {
        status: "IDENTITY_MISMATCH",
        observedProjectNodeId: organization.projectV2?.id ?? null,
        organizationNodeId: organization.id,
        observedTitle: organization.projectV2?.title ?? null,
        observedUrl: organization.projectV2?.url ?? null,
        permissionLevel: permission.permissionLevel,
        missingRequirements: [],
        lastErrorCode: mismatch.code,
        lastError: mismatch.message,
      },
    });
    return { gate: "IDENTITY_MISMATCH", binding: publicFleetProjectBinding(updated) };
  }
  const project = organization.projectV2!;
  const updated = await recordFleetProjectObservation({
    binding,
    actor: "scheduler:fleet-project-binding",
    observedAt,
    observation: {
      status: "VERIFIED",
      projectNodeId: project.id,
      observedProjectNodeId: project.id,
      organizationNodeId: organization.id,
      observedTitle: project.title,
      observedUrl: project.url,
      permissionLevel: permission.permissionLevel,
      missingRequirements: [],
      lastErrorCode: null,
      lastError: null,
      verifiedAt: observedAt,
    },
  });
  return { gate: "VERIFIED", binding: publicFleetProjectBinding(updated) };
}

export interface FleetProjectSourceApp {
  id: string;
  status: string;
  repoId: bigint | null;
  repoFullName: string;
}

export type FleetProjectSourceDisposition =
  | { kind: "CURRENT"; projectNodeId: string; bindingRevision: number }
  | { kind: "NEEDS_INPUT"; reason: string }
  | { kind: "READBACK_REQUIRED"; reason: string }
  | { kind: "INELIGIBLE"; reason: string };

export async function resolveFleetProjectSource(
  app: FleetProjectSourceApp,
): Promise<FleetProjectSourceDisposition> {
  if (app.status !== "ACTIVE" || app.repoId === null) {
    return { kind: "INELIGIBLE", reason: "ACTIVE PRODUCT_APP repository가 아닙니다." };
  }
  const registration = await prisma.repositoryRegistration.findUnique({
    where: { repoId: app.repoId },
    select: {
      repoFullName: true,
      archived: true,
      status: true,
      classification: true,
      lastDefaultPushSha: true,
      lastReconciledSha: true,
    },
  });
  const pushed = registration?.lastDefaultPushSha?.toLowerCase() ?? null;
  const reconciled = registration?.lastReconciledSha?.toLowerCase() ?? null;
  if (
    !registration
    || registration.repoFullName.toLowerCase() !== app.repoFullName.toLowerCase()
    || registration.archived
    || registration.status !== "MANAGED"
    || registration.classification !== "PRODUCT_APP"
    || pushed === null
    || pushed !== reconciled
  ) {
    return {
      kind: "INELIGIBLE",
      reason: "exact source가 재조정된 MANAGED PRODUCT_APP repository가 아닙니다.",
    };
  }
  const binding = await prisma.fleetProjectBinding.findUnique({
    where: { id: FLEET_PROJECT_BINDING_ID },
  });
  if (!binding) {
    return { kind: "NEEDS_INPUT", reason: "조직 Seorilabs Fleet Project desired state가 필요합니다." };
  }
  if (binding.status === "HUMAN_PERMISSION_REQUIRED") {
    return {
      kind: "NEEDS_INPUT",
      reason: "GitHub App installation의 all repositories 및 organization Projects read/write 승인이 필요합니다.",
    };
  }
  if (binding.status === "IDENTITY_MISMATCH") {
    return { kind: "NEEDS_INPUT", reason: "Seorilabs Fleet Project 공개 identity 확인이 필요합니다." };
  }
  if (binding.status !== "VERIFIED" || !binding.projectNodeId) {
    return { kind: "READBACK_REQUIRED", reason: "Seorilabs Fleet Project 공개 identity readback이 필요합니다." };
  }
  return {
    kind: "CURRENT",
    projectNodeId: binding.projectNodeId,
    bindingRevision: binding.revision,
  };
}
