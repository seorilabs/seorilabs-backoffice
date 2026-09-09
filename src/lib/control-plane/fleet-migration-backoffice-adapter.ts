import { computeFleetEvidenceDigest } from "seorilabs-org-contracts/repo-contract/fleet-migration";

import { projectBlueprintSchema, providerReadbackPayloadSchema } from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { compileBlueprintResources, type BlueprintResource } from "@/lib/control-plane/project-blueprint";
import { decideBlueprintReadback } from "@/lib/control-plane/provider-execution";
import { prisma } from "@/lib/prisma";

const ORGANIZATION_ID = "283115031";
// 증거 형태가 바뀌면 식별자도 함께 올린다. collector가 같은 값을 요구하므로 옛 shape을
// 돌려주는 producer는 필드 부재가 아니라 계약 불일치로 즉시 닫힌다.
export const BACKOFFICE_CONTRACT = "seorilabs-fleet-migration-backoffice-public-evidence-v3";
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

export interface FleetMigrationBindingEvidenceInput {
  binding: {
    id: string;
    state: string;
    sourceSha: string | null;
    platformRelease: { sourceSha: string; manifestDigest: string | null } | null;
  } | null;
  appId: string;
  platformAppId: string | null;
  platformRepositoryId: string;
  observedSourceSha: string;
}

/**
 * 승인된 Platform SDK 판본을 실제로 쓰고 있는지를 그대로 기록한다.
 *
 * inventory는 이관 전 실태를 남기는 것이 목적이라 판본이 어긋난 상태도 기록 대상이다.
 * 여기서 COMPLIANT를 요구하면 조직 전체가 동시에 수렴하기 전까지 실태를 한 번도 남길
 * 수 없고, 저장소 하나가 움직일 때마다 조직 전체 기록이 다시 막힌다. 판본 수렴은 이
 * 기록을 근거로 각 저장소가 이어서 하는 별도 작업이다.
 *
 * 연결 자체가 없거나, 어떤 릴리스에도 묶이지 않았거나, 어느 커밋에서 잰 상태인지 알 수
 * 없으면 기술할 대상이 없어 null로 남긴다. 이것도 "아직 아무 릴리스에도 연결되지 않았다"는
 * 사실 기록이다.
 *
 * appSourceCurrent는 그 상태를 지금 관측 중인 커밋에서 쟀는지를 뜻한다. 뒤처진 측정도
 * 기록하되, 뒤처졌다는 사실이 기록 안에서 드러나야 compliance를 오독할 수 없다.
 *
 * platformAppId는 Platform 원장에서의 앱 식별자다. 아직 등록되지 않은 저장소가 실재하므로
 * null을 그대로 기록한다. 연결이 아예 없는 것(null binding)과 "연결은 있는데 원장 쪽
 * 식별자가 없는 것"은 다른 사실이라 구분해 남긴다.
 */
/**
 * ACTIVE config가 현재 관측과 같은 source에 묶여 있는지 본다.
 *
 * 같은 커밋을 같은 payload로 다시 탐지하면 DiscoveryObservation row가 새로 생긴다.
 * readiness는 이를 provenance 무효로 보지 않는다 — 재탐지는 사실 변화가 아니기 때문이다.
 * 공개 증거가 row id 일치를 따로 요구하면 재탐지 한 번에 진단과 기록이 갈리므로 같은
 * 판정을 공유한다.
 */
export function fleetMigrationConfigSourceMatchesDiscovery(
  configSource: { sourceSha: string; payloadHash: string } | null | undefined,
  discovery: { sourceSha: string; payloadHash: string } | null | undefined,
): boolean {
  // row id가 같으면 자명하게 만족하므로 따로 지름길을 두지 않는다. 지름길을 두면 두 row가
  // 같은 id인데 source가 다른 경우를 통과시켜, source가 어긋난 것을 못 잡는다.
  if (!configSource || !discovery) return false;
  return configSource.sourceSha === discovery.sourceSha
    && configSource.payloadHash === discovery.payloadHash;
}

export function fleetMigrationBindingIsDescribable(binding: {
  sourceSha: string | null;
  hasPlatformRelease: boolean;
} | null): boolean {
  return binding !== null && binding.hasPlatformRelease && binding.sourceSha !== null;
}

export function fleetMigrationPlatformFleetBindingEvidence(
  input: FleetMigrationBindingEvidenceInput,
): Record<string, unknown> | null {
  const release = input.binding?.platformRelease ?? null;
  const appSourceSha = input.binding?.sourceSha ?? null;
  // readiness가 같은 판정을 쓰도록 하나로 모은다. 조건이 갈리면 진단은 "연결됨",
  // 기록은 "미연결"이 되어 문서가 약속한 동일 기준이 깨진다.
  if (!fleetMigrationBindingIsDescribable(
    input.binding === null
      ? null
      : { sourceSha: appSourceSha, hasPlatformRelease: release !== null },
  )) return null;
  // 위 판정이 셋을 모두 보장하지만 타입 좁히기를 위해 다시 확인한다.
  if (!input.binding || !release || !appSourceSha) return null;
  const value = {
    observationId: input.binding.id,
    revision: "1",
    appId: input.appId,
    platformAppId: input.platformAppId,
    platformRepositoryId: input.platformRepositoryId,
    platformSourceSha: release.sourceSha,
    appSourceSha,
    appSourceCurrent: appSourceSha === input.observedSourceSha,
    state: "ACTIVE",
    compliance: input.binding.state === "COMPLIANT" ? "COMPLIANT" : "DIVERGENT",
    complianceDetail: input.binding.state,
  };
  return { ...value, digest: digest({ ...value, manifestDigest: release.manifestDigest }) };
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
                sourceObservation: { select: { id: true, sourceSha: true, payloadHash: true } },
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
      // PLATFORM_PRODUCER의 App row는 드리프트가 아니다. Backoffice가 그 저장소의 PR,
      // workflow run, provider observation을 추적하는 앵커로 쓰고, mirror 관계가
      // onDelete: Restrict라 삭제 자체가 막힌다. readiness는 #339에서 이미 이 row를
      // blocker에서 뺐는데 여기만 남아 있어 진단과 기록이 갈렸다.
      const anchorOnly = registration.classification === "PLATFORM_PRODUCER";
      if ((isProduct && !app) || (!isProduct && !anchorOnly && app)) {
        fail("FLEET_MIGRATION_BACKOFFICE_APP_BINDING_DRIFT");
      }
      let appReadback: Record<string, unknown> | null = null;
      let activeConfig: Record<string, unknown> | null = null;
      let signedSnapshot: Record<string, unknown> | null = null;
      let platformFleetBinding: Record<string, unknown> | null = null;
      let providerObservations: Array<Record<string, unknown>> = [];
      let credentialBindings: Array<Record<string, unknown>> = [];
      // 제품 앱 계약은 분류로 판정한다. App row 유무로 분기하면 앵커 row를 가진
      // PLATFORM_PRODUCER가 제품 앱 계약에 걸려 config·스냅샷을 요구받는다. 그 저장소는
      // 제품 설정을 가진 적이 없다. collector도 비제품 저장소에는 전부 null을 요구한다.
      if (isProduct && app) {
        const discovery = app.discoveryObservations[0];
        const config = app.configRevisions[0];
        const binding = app.platformFleetBinding;
        // ACTIVE config가 어느 관측에 묶였는지는 row id가 아니라 그 관측이 가리키는
        // source로 본다. 같은 커밋을 같은 payload로 다시 탐지하면 새 row가 생기는데
        // readiness는 이를 provenance 무효로 보지 않는다. 여기서만 id 일치를 요구하면
        // 재탐지 한 번에 진단과 기록이 갈린다. 실측 22곳 중 11곳이 이 상태였다.
        const configSourceCurrent = fleetMigrationConfigSourceMatchesDiscovery(
          config?.sourceObservation,
          discovery,
        );
        if (
          app.configRevisions.length !== 1
          || app.repoId !== repositoryId
          || app.repoFullName !== request.fullName
          || !discovery
          || discovery.sourceSha !== request.sourceSha
          || discovery.sourceRef !== request.sourceRef
          || !config
          || !configSourceCurrent
          || !config.snapshotDigest
          || !config.snapshotSignature
          || !config.activatedAt
          || !platformRegistration
        ) fail("FLEET_MIGRATION_BACKOFFICE_PRODUCT_EVIDENCE_INCOMPLETE");

        // ProjectBlueprint는 P5 산출물이라 아직 없는 저장소가 대부분이다(실측 22곳 중 20곳).
        // 없으면 선언된 desired resource가 없다는 뜻이고, provider 실행 기록도 0건이라
        // 증명된 provider 상태 자체가 없다. 요구하면 이관 기록이 P5 완료를 기다려야 해서
        // 다시 전부-아니면-전무가 된다.
        const blueprint = projectBlueprintSchema.safeParse(config.projectBlueprint?.payload);
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
        platformFleetBinding = fleetMigrationPlatformFleetBindingEvidence({
          binding,
          appId: app.id,
          platformAppId: app.platformAppId,
          platformRepositoryId: platformRegistration.repoId.toString(),
          observedSourceSha: request.sourceSha,
        });
        providerObservations = blueprint.success
          ? publicFleetMigrationProviderObservations({
            rows: app.providerObservations,
            executions: app.providerExecutions,
            desiredResources: compileBlueprintResources(blueprint.data),
            sourceSha: request.sourceSha,
            configRevisionId: config.id,
          })
          : [];
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
