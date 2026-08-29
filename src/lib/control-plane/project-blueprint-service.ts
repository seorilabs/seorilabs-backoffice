import { Prisma } from "@prisma/client";
import { projectBlueprintSchema } from "@/lib/control-plane/contracts";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { evaluateProjectBlueprint } from "@/lib/control-plane/project-blueprint";
import { prisma } from "@/lib/prisma";

type ProjectBlueprintPlanClient = Prisma.TransactionClient | typeof prisma;

export interface ProjectBlueprintPlanInput {
  appId: string;
  repoId: bigint;
  sourceSha: string;
  configRevision: number;
}

/** transaction snapshot에서 exact app/source/config에 고정된 apply/readback plan만 반환한다. */
export async function getProjectBlueprintPlanWithClient(
  client: ProjectBlueprintPlanClient,
  input: ProjectBlueprintPlanInput,
) {
  const app = await client.app.findUnique({
    where: { id: input.appId },
    select: {
      id: true,
      repoId: true,
      discoveryObservations: {
        where: { sourceSha: input.sourceSha.toLowerCase() },
        take: 1,
        select: { id: true },
      },
      configRevisions: {
        where: { revision: input.configRevision },
        take: 1,
        select: {
          revision: true,
          status: true,
          projectBlueprint: { select: { payload: true } },
        },
      },
      providerObservations: {
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: 2_000,
        select: {
          id: true,
          provider: true,
          resourceType: true,
          resourceId: true,
          payload: true,
          observedAt: true,
          createdAt: true,
        },
      },
      credentialBindings: {
        select: {
          logicalCredentialId: true,
          capability: true,
          status: true,
          publicIdentity: true,
        },
      },
    },
  });
  if (!app || app.repoId !== input.repoId) {
    throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  }
  if (app.discoveryObservations.length !== 1) {
    throw new ControlPlaneError(
      "정확한 source SHA의 DiscoveryObservation이 필요합니다.",
      409,
      "SOURCE_NOT_OBSERVED",
    );
  }
  const revision = app.configRevisions[0];
  if (!revision) throw new ControlPlaneError("Config revision을 찾을 수 없습니다.", 404, "REVISION_NOT_FOUND");
  if (revision.status !== "ACTIVE") {
    throw new ControlPlaneError("ACTIVE Config revision만 plan에 사용할 수 있습니다.", 409, "REVISION_NOT_ACTIVE");
  }
  if (!revision.projectBlueprint) {
    throw new ControlPlaneError("ACTIVE revision에 ProjectBlueprint가 없습니다.", 409, "BLUEPRINT_NOT_CONFIGURED");
  }
  const blueprint = projectBlueprintSchema.parse(revision.projectBlueprint.payload);
  return {
    appId: app.id,
    ...evaluateProjectBlueprint({
      repoId: input.repoId,
      sourceSha: input.sourceSha,
      configRevision: revision.revision,
      blueprint,
      observations: app.providerObservations,
      credentialBindings: app.credentialBindings,
    }),
  };
}

/** provider write 없이 exact source/config에 고정된 apply/readback plan만 반환한다. */
export async function getProjectBlueprintPlan(input: {
  repoId: bigint;
  sourceSha: string;
  configRevision: number;
}) {
  const app = await prisma.app.findUnique({
    where: { repoId: input.repoId },
    select: { id: true },
  });
  if (!app) throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  return getProjectBlueprintPlanWithClient(prisma, { ...input, appId: app.id });
}
