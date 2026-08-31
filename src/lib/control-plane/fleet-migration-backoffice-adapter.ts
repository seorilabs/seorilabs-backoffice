import { computeFleetEvidenceDigest } from "@seorilabs/repo-contract/fleet-migration";

import { projectBlueprintSchema, providerReadbackPayloadSchema } from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { compileBlueprintResources, type BlueprintResource } from "@/lib/control-plane/project-blueprint";
import { decideBlueprintReadback } from "@/lib/control-plane/provider-execution";
import { prisma } from "@/lib/prisma";

const ORGANIZATION_ID = "283115031";
const BACKOFFICE_CONTRACT = "seorilabs-fleet-migration-backoffice-public-evidence-v1";
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PRIVATE_KEY = /^(?:authorization|bytes|cookie|credentialValue|password|payload|privateKey|privateKeyPem|rawSecret|secret|secretValue|token)$/iu;
const PRIVATE_VALUE = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
];

interface BackofficeRequest {
  contract: string;
  organizationId: string;
  repositoryId: string;
  fullName: string;
  sourceRef: string;
  sourceSha: string;
  treeSha: string;
  blobInventoryDigest: string;
  detections: unknown[];
}

type BackofficeClient = Pick<
  typeof prisma,
  "repositoryRegistration" | "app" | "fleetMigrationProofSnapshot"
>;

function fail(code: string): never {
  throw new Error(code);
}

function evidence<T extends Record<string, unknown>>(value: T): T & { evidenceDigest: string } {
  const result = { ...value, evidenceDigest: `sha256:${"0".repeat(64)}` };
  result.evidenceDigest = computeFleetEvidenceDigest(result);
  return result;
}

function digest(value: unknown): string {
  return `sha256:${jsonDigest(value as JsonValue)}`;
}

function assertSecretFree(value: unknown): void {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === "string") {
      if (PRIVATE_VALUE.some((pattern) => pattern.test(item))) {
        fail("FLEET_MIGRATION_BACKOFFICE_PRIVATE_SURFACE_REJECTED");
      }
      return;
    }
    if (item === null || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      if (PRIVATE_KEY.test(key)) fail("FLEET_MIGRATION_BACKOFFICE_PRIVATE_SURFACE_REJECTED");
      visit(nested);
    }
  };
  visit(value);
}

function parseRequest(value: Record<string, unknown>): BackofficeRequest {
  if (
    value.contract !== BACKOFFICE_CONTRACT
    || value.organizationId !== ORGANIZATION_ID
    || typeof value.repositoryId !== "string"
    || !/^[1-9][0-9]{0,31}$/u.test(value.repositoryId)
    || typeof value.fullName !== "string"
    || !/^seorilabs\/[A-Za-z0-9._-]+$/u.test(value.fullName)
    || typeof value.sourceRef !== "string"
    || typeof value.sourceSha !== "string"
    || !SHA.test(value.sourceSha)
    || typeof value.treeSha !== "string"
    || !SHA.test(value.treeSha)
    || typeof value.blobInventoryDigest !== "string"
    || !DIGEST.test(value.blobInventoryDigest)
    || !Array.isArray(value.detections)
  ) fail("FLEET_MIGRATION_BACKOFFICE_REQUEST_INVALID");
  return value as unknown as BackofficeRequest;
}

interface ProviderObservationRow {
  id: string;
  provider: string;
  resourceType: string;
  resourceId: string;
  payload: unknown;
  payloadHash: string;
  observedAt: Date;
  createdAt: Date;
}

interface ProviderExecutionRow {
  id: string;
  provider: string;
  resourceType: string;
  resourceId: string;
  sourceSha: string;
  configRevisionId: string;
  desiredHash: string;
  expectedPublicIdentity: string | null;
  lastObservationId: string | null;
  status: string;
  leaseGeneration: number;
  completedAt: Date | null;
  createdAt: Date;
}

function providerResourceKey(value: { provider: string; resourceType: string; resourceId: string }): string {
  return JSON.stringify([value.provider.toLowerCase(), value.resourceType, value.resourceId]);
}

export function publicFleetMigrationProviderObservations(input: {
  rows: ProviderObservationRow[];
  executions: ProviderExecutionRow[];
  desiredResources: readonly BlueprintResource[];
  sourceSha: string;
  configRevisionId: string;
}): Array<Record<string, unknown>> {
  if (input.rows.length > 10_000 || input.executions.length > 10_000) {
    fail("FLEET_MIGRATION_PROVIDER_HISTORY_LIMIT_EXCEEDED");
  }
  const observations = new Map(input.rows.map((row) => [row.id, row]));
  const desired = new Map(input.desiredResources.map((resource) => [providerResourceKey(resource), resource]));
  if (
    desired.size !== input.desiredResources.length
    || desired.size < 1
    || desired.size > 100
  ) fail("FLEET_MIGRATION_PROVIDER_DESIRED_RESOURCE_SET_INVALID");
  const latest = new Map<string, ProviderExecutionRow>();
  const executions = input.executions
    .filter((execution) => (
      execution.sourceSha === input.sourceSha
      && execution.configRevisionId === input.configRevisionId
    ))
    .sort((left, right) => (
      right.createdAt.getTime() - left.createdAt.getTime()
      || right.id.localeCompare(left.id)
    ));
  for (const execution of executions) {
    const key = providerResourceKey(execution);
    if (!latest.has(key)) latest.set(key, execution);
  }
  if (
    latest.size !== desired.size
    || [...latest.keys()].some((key) => !desired.has(key))
    || [...desired.keys()].some((key) => !latest.has(key))
  ) fail("FLEET_MIGRATION_PROVIDER_EXECUTION_COVERAGE_INCOMPLETE");

  const result: Array<Record<string, unknown>> = [];
  for (const [key, expected] of [...desired.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const execution = latest.get(key)!;
    const row = execution.lastObservationId ? observations.get(execution.lastObservationId) : undefined;
    if (
      execution.desiredHash !== expected.desiredHash
      || execution.expectedPublicIdentity !== (expected.publicIdentity ?? null)
      || execution.status !== "SUCCEEDED"
      || !execution.completedAt
      || !row
      || providerResourceKey(row) !== providerResourceKey(execution)
      || row.observedAt.getTime() > execution.completedAt.getTime()
      || row.createdAt.getTime() > execution.completedAt.getTime()
      || !/^[0-9a-f]{64}$/u.test(row.payloadHash)
      || jsonDigest(row.payload as JsonValue) !== row.payloadHash
    ) fail("FLEET_MIGRATION_PROVIDER_OBSERVATION_PROVENANCE_INVALID");
    const payload = providerReadbackPayloadSchema.safeParse(row.payload);
    if (!payload.success) fail("FLEET_MIGRATION_PROVIDER_OBSERVATION_INVALID");
    const decision = decideBlueprintReadback(payload.data, {
      desiredHash: execution.desiredHash,
      publicIdentity: execution.expectedPublicIdentity,
    });
    if (decision !== "COMPLIANT") {
      fail(`FLEET_MIGRATION_PROVIDER_LATEST_STATE_${decision}`);
    }
    const publicIdentity = payload.data.publicIdentity ?? `${row.resourceType}:${row.resourceId}`;
    if (publicIdentity.length < 1 || publicIdentity.length > 512) {
      fail("FLEET_MIGRATION_PROVIDER_PUBLIC_IDENTITY_INVALID");
    }
    result.push({
      observationId: row.id,
      revision: String(Math.max(1, execution.leaseGeneration)),
      digest: `sha256:${row.payloadHash}`,
      provider: row.provider,
      publicIdentity,
      state: "MATCH",
    });
  }
  return result.sort((left, right) => String(left.observationId).localeCompare(String(right.observationId)));
}

export function stableFleetMigrationBackofficeStateDigest(
  publicEvidence: Record<string, unknown>,
): string {
  const providerObservations = (publicEvidence.providerObservations as Array<Record<string, unknown>>)
    .map((item) => {
      const stable = { ...item };
      Reflect.deleteProperty(stable, "evidenceDigest");
      Reflect.deleteProperty(stable, "observationId");
      return stable;
    })
    .sort((left, right) => String(left.digest).localeCompare(String(right.digest)));
  const credentialBindings = (publicEvidence.credentialBindings as Array<Record<string, unknown>>)
    .map((item) => {
      const stable = { ...item };
      Reflect.deleteProperty(stable, "evidenceDigest");
      Reflect.deleteProperty(stable, "observationId");
      return stable;
    })
    .sort((left, right) => String(left.logicalCredentialId).localeCompare(String(right.logicalCredentialId)));
  return jsonDigest({
    classification: publicEvidence.classification as JsonValue,
    classificationDecisionRevision: publicEvidence.classificationDecisionRevision as JsonValue,
    classificationDecisionId: publicEvidence.classificationDecisionId as JsonValue,
    app: publicEvidence.app as JsonValue,
    activeConfig: publicEvidence.activeConfig as JsonValue,
    signedSnapshot: publicEvidence.signedSnapshot as JsonValue,
    platformFleetBinding: publicEvidence.platformFleetBinding as JsonValue,
    providerObservations: providerObservations as unknown as JsonValue,
    credentialBindings: credentialBindings as unknown as JsonValue,
  });
}

export function fleetMigrationProofDigest(input: {
  repositoryId: string;
  repositoryFullName: string;
  sourceSha: string;
  treeSha: string;
  blobInventoryDigest: string;
  detectorSourceSha: string;
  readinessEvidenceDigest: string;
  readinessCohortDigest: string;
  stableBackofficeStateDigest: string;
  candidatesDigest: string;
}): string {
  return jsonDigest(input as unknown as JsonValue);
}

function publicCredentialBindings(rows: Array<{
  id: string;
  logicalCredentialId: string;
  provider: string;
  capability: string;
  environment: string;
  publicIdentity: string | null;
  fingerprint: string | null;
  credentialGeneration: number | null;
  policyGeneration: number | null;
}>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const revision = Math.max(row.credentialGeneration ?? 1, row.policyGeneration ?? 1);
    const binding = {
      observationId: row.id,
      revision: String(revision),
      logicalCredentialId: row.logicalCredentialId,
      provider: row.provider,
      capability: row.capability,
      environment: row.environment,
      publicIdentity: row.publicIdentity,
      fingerprint: row.fingerprint,
      status: "ACTIVE",
    };
    return { ...binding, digest: digest(binding) };
  }).sort((left, right) => JSON.stringify({
    capability: left.capability,
    environment: left.environment,
    logicalCredentialId: left.logicalCredentialId,
    provider: left.provider,
  }).localeCompare(JSON.stringify({
    capability: right.capability,
    environment: right.environment,
    logicalCredentialId: right.logicalCredentialId,
    provider: right.provider,
  })));
}

export function createFleetMigrationBackofficeAdapter(input: {
  detectorSourceSha: string;
  readinessEvidenceDigest: string;
  readinessCohortDigest: string;
  snapshotSigningKeyId: string;
  snapshotPolicyRevision: string;
  approvedProofDigests: readonly string[];
  client?: BackofficeClient;
  now?: () => Date;
}) {
  if (
    !SHA.test(input.detectorSourceSha)
    || !/^[0-9a-f]{64}$/u.test(input.readinessEvidenceDigest)
    || !/^[0-9a-f]{64}$/u.test(input.readinessCohortDigest)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.snapshotSigningKeyId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.snapshotPolicyRevision)
    || input.approvedProofDigests.some((value) => !/^[0-9a-f]{64}$/u.test(value))
    || new Set(input.approvedProofDigests).size !== input.approvedProofDigests.length
  ) fail("FLEET_MIGRATION_BACKOFFICE_CONFIGURATION_INVALID");
  const client = input.client ?? prisma;
  const approvedProofDigests = new Set(input.approvedProofDigests);

  async function readBackoffice(value: Record<string, unknown>, requireProof: boolean) {
      const request = parseRequest(value);
      const repositoryId = BigInt(request.repositoryId);
      const [registration, app, platformRegistration] = await Promise.all([
        client.repositoryRegistration.findUnique({
          where: { repoId: repositoryId },
          select: {
            repoId: true,
            repoFullName: true,
            defaultBranch: true,
            classification: true,
            classificationDecisionVersion: true,
            classificationDecisions: {
              orderBy: { revision: "desc" },
              take: 1,
              select: { id: true, revision: true, classification: true },
            },
          },
        }),
        client.app.findUnique({
          where: { repoId: repositoryId },
          select: {
            id: true,
            repoId: true,
            repoFullName: true,
            status: true,
            platformAppId: true,
            discoveryObservations: {
              orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
              take: 1,
              select: { id: true, sourceSha: true, sourceRef: true, payloadHash: true },
            },
            configRevisions: {
              where: { status: "ACTIVE" },
              orderBy: { revision: "desc" },
              take: 2,
              select: {
                id: true,
                revision: true,
                payloadHash: true,
                snapshotDigest: true,
                snapshotSignature: true,
                sourceObservationId: true,
                activatedAt: true,
                projectBlueprint: { select: { payload: true } },
              },
            },
            platformFleetBinding: {
              select: {
                id: true,
                state: true,
                sourceSha: true,
                updatedAt: true,
                platformRelease: { select: { sourceSha: true, manifestDigest: true } },
              },
            },
            providerObservations: {
              orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
              take: 10_001,
              select: {
                id: true,
                provider: true,
                resourceType: true,
                resourceId: true,
                payload: true,
                payloadHash: true,
                observedAt: true,
                createdAt: true,
              },
            },
            providerExecutions: {
              where: {
                kind: "BLUEPRINT_RESOURCE",
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 10_001,
              select: {
                id: true,
                provider: true,
                resourceType: true,
                resourceId: true,
                sourceSha: true,
                configRevisionId: true,
                desiredHash: true,
                expectedPublicIdentity: true,
                lastObservationId: true,
                status: true,
                leaseGeneration: true,
                completedAt: true,
                createdAt: true,
              },
            },
            credentialBindings: {
              where: { status: "ACTIVE" },
              orderBy: { id: "asc" },
              take: 100,
              select: {
                id: true,
                logicalCredentialId: true,
                provider: true,
                capability: true,
                environment: true,
                publicIdentity: true,
                fingerprint: true,
                credentialGeneration: true,
                policyGeneration: true,
              },
            },
          },
        }),
        client.repositoryRegistration.findUnique({
          where: { repoFullName: "seorilabs/platform" },
          select: { repoId: true },
        }),
      ]);
      const decision = registration?.classificationDecisions[0];
      if (
        !registration
        || registration.repoId !== repositoryId
        || registration.repoFullName !== request.fullName
        || `refs/heads/${registration.defaultBranch}` !== request.sourceRef
        || !registration.classification
        || !decision
        || decision.revision !== registration.classificationDecisionVersion
        || decision.classification !== registration.classification
      ) fail("FLEET_MIGRATION_BACKOFFICE_IDENTITY_DRIFT");

      const isProduct = registration.classification === "PRODUCT_APP";
      if ((isProduct && !app) || (!isProduct && app)) {
        fail("FLEET_MIGRATION_BACKOFFICE_APP_BINDING_DRIFT");
      }
      let appReadback: Record<string, unknown> | null = null;
      let activeConfig: Record<string, unknown> | null = null;
      let signedSnapshot: Record<string, unknown> | null = null;
      let platformFleetBinding: Record<string, unknown> | null = null;
      let providerObservations: Array<Record<string, unknown>> = [];
      let credentialBindings: Array<Record<string, unknown>> = [];
      if (app) {
        const discovery = app.discoveryObservations[0];
        const config = app.configRevisions[0];
        const binding = app.platformFleetBinding;
        const blueprint = projectBlueprintSchema.safeParse(config?.projectBlueprint?.payload);
        if (
          app.configRevisions.length !== 1
          || app.repoId !== repositoryId
          || app.repoFullName !== request.fullName
          || !discovery
          || discovery.sourceSha !== request.sourceSha
          || discovery.sourceRef !== request.sourceRef
          || !config
          || config.sourceObservationId !== discovery.id
          || !config.snapshotDigest
          || !config.snapshotSignature
          || !config.activatedAt
          || !blueprint.success
          || !binding
          || binding.state !== "COMPLIANT"
          || binding.sourceSha !== request.sourceSha
          || !binding.platformRelease
          || !app.platformAppId
          || !platformRegistration
        ) fail("FLEET_MIGRATION_BACKOFFICE_PRODUCT_EVIDENCE_INCOMPLETE");
        appReadback = {
          appId: app.id,
          revision: "1",
          digest: digest({ appId: app.id, repositoryId: request.repositoryId, sourceSha: request.sourceSha, lifecycleStatus: app.status }),
          repositoryId: request.repositoryId,
          sourceSha: request.sourceSha,
          state: "ACTIVE",
        };
        activeConfig = {
          configRevisionId: config.id,
          revision: String(config.revision),
          digest: `sha256:${config.payloadHash}`,
          signedSnapshotDigest: `sha256:${config.snapshotDigest}`,
          state: "ACTIVE",
        };
        signedSnapshot = {
          snapshotId: `${config.id}-snapshot`,
          snapshotDigest: `sha256:${config.snapshotDigest}`,
          signatureKeyId: input.snapshotSigningKeyId,
          policyRevision: input.snapshotPolicyRevision,
          state: "VERIFIED",
        };
        const bindingValue = {
          observationId: binding.id,
          revision: "1",
          appId: app.id,
          platformAppId: app.platformAppId,
          platformRepositoryId: platformRegistration.repoId.toString(),
          platformSourceSha: binding.platformRelease.sourceSha,
          state: "ACTIVE",
        };
        platformFleetBinding = { ...bindingValue, digest: digest({ ...bindingValue, manifestDigest: binding.platformRelease.manifestDigest }) };
        providerObservations = publicFleetMigrationProviderObservations({
          rows: app.providerObservations,
          executions: app.providerExecutions,
          desiredResources: compileBlueprintResources(blueprint.data),
          sourceSha: request.sourceSha,
          configRevisionId: config.id,
        });
        credentialBindings = publicCredentialBindings(app.credentialBindings);
      }
      const now = input.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) fail("FLEET_MIGRATION_BACKOFFICE_TIME_INVALID");
      const publicEvidence = evidence({
        contract: BACKOFFICE_CONTRACT,
        readbackId: `backoffice-readback-${jsonDigest({ repositoryId: request.repositoryId, sourceSha: request.sourceSha, at: now.toISOString() } as JsonValue).slice(0, 32)}`,
        observedAt: now.toISOString(),
        organizationId: ORGANIZATION_ID,
        repositoryId: request.repositoryId,
        fullName: request.fullName,
        sourceSha: request.sourceSha,
        classification: registration.classification,
        classificationDecisionRevision: decision.revision,
        classificationDecisionId: decision.id,
        app: appReadback,
        activeConfig,
        signedSnapshot,
        platformFleetBinding,
        providerObservations,
        credentialBindings,
      });

      const stableBackofficeStateDigest = stableFleetMigrationBackofficeStateDigest(publicEvidence);
      if (!requireProof) {
        assertSecretFree(publicEvidence);
        return { publicEvidence, stableBackofficeStateDigest };
      }
      const proofSnapshot = await client.fleetMigrationProofSnapshot.findFirst({
        where: {
          repositoryId,
          repositoryFullName: request.fullName,
          sourceSha: request.sourceSha,
          treeSha: request.treeSha,
          blobInventoryDigest: request.blobInventoryDigest,
          detectorSourceSha: input.detectorSourceSha,
          readinessEvidenceDigest: input.readinessEvidenceDigest,
          readinessCohortDigest: input.readinessCohortDigest,
          stableBackofficeStateDigest,
        },
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      });

      if (
        !proofSnapshot
        || proofSnapshot.repositoryFullName !== request.fullName
        || proofSnapshot.readinessEvidenceDigest !== input.readinessEvidenceDigest
        || proofSnapshot.readinessCohortDigest !== input.readinessCohortDigest
        || proofSnapshot.stableBackofficeStateDigest !== stableBackofficeStateDigest
        || !Array.isArray(proofSnapshot.candidates)
        || proofSnapshot.candidatesDigest !== digest(proofSnapshot.candidates)
        || proofSnapshot.proofDigest !== fleetMigrationProofDigest({
          repositoryId: request.repositoryId,
          repositoryFullName: request.fullName,
          sourceSha: request.sourceSha,
          treeSha: request.treeSha,
          blobInventoryDigest: request.blobInventoryDigest,
          detectorSourceSha: input.detectorSourceSha,
          readinessEvidenceDigest: input.readinessEvidenceDigest,
          readinessCohortDigest: input.readinessCohortDigest,
          stableBackofficeStateDigest,
          candidatesDigest: proofSnapshot.candidatesDigest,
        })
        || !approvedProofDigests.has(proofSnapshot.proofDigest)
        || proofSnapshot.approvalAttestationDigest !== jsonDigest(proofSnapshot.approvalAttestation as JsonValue)
      ) fail("FLEET_MIGRATION_PROOF_SNAPSHOT_MISSING_OR_STALE");
      const candidates = structuredClone(proofSnapshot.candidates) as Array<Record<string, unknown>>;
      const scannedByKey = new Map(request.detections.map((scanned) => {
        const item = scanned as { path?: unknown; contentDigest?: unknown; detection?: unknown; gitEntry?: unknown };
        return [jsonDigest({ path: item.path, contentDigest: item.contentDigest, detection: item.detection } as JsonValue), item];
      }));
      for (const candidate of candidates) {
        const path = candidate.path;
        const contentDigest = candidate.contentDigest;
        const scanned = scannedByKey.get(jsonDigest({ path, contentDigest, detection: candidate.detection } as JsonValue));
        if (
          typeof path !== "string"
          || typeof contentDigest !== "string"
          || !DIGEST.test(contentDigest)
          || !scanned?.gitEntry
        ) {
          fail("FLEET_MIGRATION_PROOF_SNAPSHOT_INVALID");
        }
        const proofs = candidate.proofs;
        if (!proofs || typeof proofs !== "object" || Array.isArray(proofs)) {
          fail("FLEET_MIGRATION_PROOF_SNAPSHOT_INVALID");
        }
        (proofs as Record<string, unknown>).sourceReadback = evidence({
          observationId: `source-proof-${jsonDigest({ repositoryId: request.repositoryId, sourceSha: request.sourceSha, path, contentDigest } as JsonValue).slice(0, 32)}`,
          observedAt: now.toISOString(),
          repositoryId: request.repositoryId,
          sourceRef: request.sourceRef,
          sourceSha: request.sourceSha,
          treeSha: request.treeSha,
          path,
          gitEntry: scanned.gitEntry,
          contentDigest,
          state: "MATCH",
        });
      }
      assertSecretFree({ publicEvidence, candidates });
      return { publicEvidence, candidates };
  }

  return Object.freeze({
    readBackofficePublicEvidence: (value: Record<string, unknown>) => readBackoffice(value, true),
    readStableBackofficeState: (value: Record<string, unknown>) => readBackoffice(value, false),
  });
}
