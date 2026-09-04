import {
  projectBlueprintSchema,
  providerReadbackPayloadSchema,
  type ProjectBlueprint,
} from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

export type BlueprintResourceState =
  | "PRESENT"
  | "ABSENT"
  | "DRIFT"
  | "UNOBSERVED"
  | "FORBIDDEN"
  | "ERROR"
  | "INVALID_OBSERVATION";

export interface BlueprintResource {
  provider: "gcp" | "firebase" | "google-analytics" | "bigquery" | "google-workspace";
  resourceType: string;
  resourceId: string;
  desiredHash: string;
  desired: JsonValue;
  publicIdentity?: string;
}

export interface BlueprintObservation {
  id?: string;
  provider: string;
  resourceType: string;
  resourceId: string;
  payload: unknown;
  observedAt: Date;
  createdAt?: Date;
}

export interface PublicCredentialBinding {
  logicalCredentialId: string;
  capability: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "NEEDS_REAUTH";
  publicIdentity?: string | null;
}

function resource(
  provider: BlueprintResource["provider"],
  resourceType: string,
  resourceId: string,
  desired: JsonValue,
  publicIdentity?: string,
): BlueprintResource {
  return {
    provider,
    resourceType,
    resourceId,
    desiredHash: jsonDigest(desired),
    desired,
    ...(publicIdentity ? { publicIdentity } : {}),
  };
}

/** 같은 blueprint는 입력 순서와 무관하게 같은 provider plan을 만든다. */
export function compileBlueprintResources(input: ProjectBlueprint): BlueprintResource[] {
  const blueprint = projectBlueprintSchema.parse(input);
  const projectId = blueprint.project.projectId;
  const resources: BlueprintResource[] = [
    resource("gcp", "project", projectId, {
      organizationId: blueprint.organizationId,
      folderId: blueprint.folderId,
      billingAccountId: blueprint.billingAccountId,
      project: blueprint.project,
    }),
    resource("gcp", "budget", projectId, blueprint.budget),
    resource("firebase", "auth", projectId, {
      providers: [...blueprint.firebase.authProviders].sort(),
    }),
    resource("firebase", "firestore-rules", projectId, {
      checksum: blueprint.firebase.firestoreRulesChecksum,
    }),
    resource("firebase", "firestore-indexes", projectId, {
      checksum: blueprint.firebase.firestoreIndexesChecksum,
    }),
    resource("firebase", "storage-rules", projectId, {
      checksum: blueprint.firebase.storageRulesChecksum,
    }),
    resource("bigquery", "dataset", `${blueprint.analytics.bigQueryProjectId}:${blueprint.analytics.datasetId}`, {
      location: blueprint.analytics.location,
    }),
  ];

  if (blueprint.firebase.functions) {
    resources.push(resource("firebase", "functions", projectId, blueprint.firebase.functions));
  }
  for (const registration of [...blueprint.firebase.appCheck.registrations]
    .sort((left, right) => left.platform.localeCompare(right.platform))) {
    resources.push(resource(
      "firebase",
      "app-check-registration",
      `${projectId}/${registration.platform.toLowerCase()}`,
      { managementMode: blueprint.firebase.appCheck.managementMode, ...registration },
      registration.publicAppId,
    ));
  }
  for (const enforcement of [...blueprint.firebase.appCheck.apiEnforcement]
    .sort((left, right) => left.api.localeCompare(right.api))) {
    resources.push(resource(
      "firebase",
      "app-check-api",
      `${projectId}/${enforcement.api.toLowerCase()}`,
      { managementMode: blueprint.firebase.appCheck.managementMode, ...enforcement },
    ));
  }

  if (blueprint.analytics.ga4PropertyId) {
    resources.push(resource(
      "google-analytics",
      "ga4-property-link",
      blueprint.analytics.ga4PropertyId,
      {
        projectId,
        datasetId: blueprint.analytics.datasetId,
      },
    ));
  }
  for (const api of [...blueprint.apis].sort()) {
    resources.push(resource("gcp", "api", `${projectId}/${api}`, { api }));
  }
  for (const binding of [...blueprint.iam].sort((left, right) => (
    `${left.role}:${left.publicIdentity}`.localeCompare(`${right.role}:${right.publicIdentity}`)
  ))) {
    const resourceId = `${projectId}/iam/${jsonDigest(binding as JsonValue).slice(0, 24)}`;
    resources.push(resource("gcp", "iam-binding", resourceId, binding, binding.publicIdentity));
  }
  for (const app of [...blueprint.firebase.apps].sort((left, right) => left.platform.localeCompare(right.platform))) {
    const publicIdentity = app.publicAppId ?? app.packageId ?? app.bundleId ?? app.aitAppName;
    resources.push(resource(
      "firebase",
      "app-registration",
      `${projectId}/${app.platform.toLowerCase()}`,
      app as JsonValue,
      publicIdentity,
    ));
  }
  for (const group of [...(blueprint.workspace?.groups ?? [])].sort((left, right) => left.email.localeCompare(right.email))) {
    resources.push(resource("google-workspace", "group", group.email.toLowerCase(), group, group.email.toLowerCase()));
  }
  for (const delegation of [...(blueprint.workspace?.domainWideDelegation ?? [])].sort((left, right) => (
    left.publicClientId.localeCompare(right.publicClientId)
  ))) {
    resources.push(resource(
      "google-workspace",
      "domain-wide-delegation",
      delegation.publicClientId,
      { ...delegation, scopes: [...delegation.scopes].sort() },
      delegation.publicClientId,
    ));
  }
  return resources.sort((left, right) => (
    `${left.provider}:${left.resourceType}:${left.resourceId}`
      .localeCompare(`${right.provider}:${right.resourceType}:${right.resourceId}`)
  ));
}

function latestObservation(
  observations: BlueprintObservation[],
  desired: BlueprintResource,
): BlueprintObservation | undefined {
  return observations
    .filter((observation) => (
      observation.provider.toLowerCase() === desired.provider
      && observation.resourceType === desired.resourceType
      && observation.resourceId === desired.resourceId
    ))
    .sort((left, right) => (
      right.observedAt.getTime() - left.observedAt.getTime()
      || (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0)
      || (right.id ?? "").localeCompare(left.id ?? "")
    ))[0];
}

export function blueprintResourceState(
  desired: BlueprintResource,
  observation: BlueprintObservation | undefined,
): BlueprintResourceState {
  if (!observation) return "UNOBSERVED";
  const readback = providerReadbackPayloadSchema.safeParse(observation.payload);
  if (!readback.success) return "INVALID_OBSERVATION";
  if (readback.data.visibility === "FORBIDDEN") return "FORBIDDEN";
  if (readback.data.visibility === "ERROR") return "ERROR";
  if (readback.data.state === "ABSENT") return "ABSENT";
  if (readback.data.state !== "PRESENT") return "UNOBSERVED";
  if (desired.publicIdentity && readback.data.publicIdentity !== desired.publicIdentity) return "DRIFT";
  const observedHash = readback.data.attributes.desiredHash;
  return observedHash === desired.desiredHash ? "PRESENT" : "DRIFT";
}

const REQUIRED_PROVISIONERS = {
  gcp: "gcp-project-provision",
  firebase: "firebase-provision",
  workspace: "workspace-provision",
} as const;

export function evaluateProjectBlueprint(input: {
  repoId: bigint;
  sourceSha: string;
  configRevision: number;
  blueprint: ProjectBlueprint;
  observations: BlueprintObservation[];
  credentialBindings: PublicCredentialBinding[];
}) {
  const blueprint = projectBlueprintSchema.parse(input.blueprint);
  const requiredProvisioners = Object.entries(REQUIRED_PROVISIONERS).filter(([key]) => (
    key !== "workspace" || blueprint.workspace !== undefined
  ));
  const credentialChecks = requiredProvisioners.map(([key, capability]) => {
    const logicalCredentialId = blueprint.provisioners[key as keyof typeof REQUIRED_PROVISIONERS];
    const binding = input.credentialBindings.find((candidate) => (
      candidate.logicalCredentialId === logicalCredentialId
      && candidate.capability === capability
    ));
    const substitute = input.credentialBindings.find((candidate) => (
      candidate.capability === capability
      && candidate.status === "ACTIVE"
      && candidate.logicalCredentialId.startsWith("app/")
    ));
    const state = binding?.status === "ACTIVE"
      ? "READY"
      : substitute
        ? "APP_SPECIFIC_SUBSTITUTE_REJECTED"
        : binding
          ? binding.status
          : "MISSING";
    return {
      provisioner: key,
      capability,
      logicalCredentialId,
      publicIdentity: binding?.publicIdentity ?? null,
      state,
    };
  });

  const resources = compileBlueprintResources(blueprint).map((desired) => {
    const observation = latestObservation(input.observations, desired);
    return {
      ...desired,
      state: blueprintResourceState(desired, observation),
      providerObservationId: observation?.id ?? null,
    };
  });
  const permissionBlocked = resources.some((candidate) => (
    candidate.state === "FORBIDDEN"
    || candidate.state === "ERROR"
    || candidate.state === "INVALID_OBSERVATION"
  ));
  const credentialBlocked = credentialChecks.some((candidate) => candidate.state !== "READY");
  const needsApply = resources.some((candidate) => candidate.state !== "PRESENT");

  return {
    schemaVersion: 1 as const,
    repoId: input.repoId.toString(),
    sourceSha: input.sourceSha.toLowerCase(),
    configRevision: input.configRevision,
    projectId: blueprint.project.projectId,
    status: permissionBlocked || credentialBlocked
      ? "BLOCKED"
      : needsApply
        ? "READY_TO_APPLY"
        : "COMPLIANT",
    credentialChecks,
    resources,
  };
}
