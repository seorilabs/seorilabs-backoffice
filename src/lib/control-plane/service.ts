import { Prisma, type ConfigRevision } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  androidBuildBindingObservationSchema,
  configRevisionPayloadSchema,
  type AndroidBuildBindingObservation,
  type DependencyAuditException,
  workflowCallerSchema,
  type ReauthGate,
  type WorkflowCaller,
} from "@/lib/control-plane/contracts";
import { createDraftRevisionInTransaction } from "@/lib/control-plane/config-revision-store";
import { projectDiscoveryConfigPayload } from "@/lib/control-plane/config-revision-discovery-projection";
import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import { jsonDigest, signSnapshot, verifySnapshot, type JsonValue } from "@/lib/control-plane/json";
import {
  type GitHubActionsBuildManifestIdentity,
  GITHUB_ACTIONS_STATIC_WORKFLOW_PATHS,
  type GitHubActionsStaticManifestIdentity,
  type GitHubActionsStaticWorkflowPath,
} from "@/lib/control-plane/github-actions-oidc";
import {
  buildStaticRuntimeManifestReadback,
  StaticRuntimeManifestError,
  type StaticRuntimeBinding,
} from "@/lib/control-plane/static-runtime-manifest";
import {
  buildRuntimeManifestReadback,
  BuildRuntimeManifestError,
} from "@/lib/control-plane/build-runtime-manifest";
import {
  BUILD_TARGET_MARKETS,
  exactBuildTargetIdentity,
  type BuildTargetMarket,
} from "@/lib/control-plane/build-target-identity";
import { REPOSITORY_DISCOVERY_CONTRACT_VERSION } from "@/lib/control-plane/repository-discovery";
import { repositoryDefaultBranchRef } from "@/lib/control-plane/repository-source-ref";

export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

type DependencyAuditActionClass = DependencyAuditException["bindings"][number]["actionClass"];

function resolveDependencyAuditException(input: {
  exception: DependencyAuditException | undefined;
  actionClass: DependencyAuditActionClass;
  repositoryId: string;
  fullName: string;
  applicationSourceSha: string;
  now: Date;
}): DependencyAuditException | undefined {
  if (!input.exception) return undefined;
  if (!Number.isFinite(input.now.getTime())) {
    throw new ControlPlaneError(
      "dependency audit 예외의 만료 시각을 검증할 수 없습니다.",
      503,
      "DEPENDENCY_AUDIT_EXCEPTION_CLOCK_INVALID",
    );
  }
  if (
    input.exception.repositoryId !== input.repositoryId
    || input.exception.fullName !== input.fullName
  ) {
    throw new ControlPlaneError(
      "dependency audit 예외의 repository identity가 runtime 요청과 일치하지 않습니다.",
      409,
      "DEPENDENCY_AUDIT_EXCEPTION_IDENTITY_MISMATCH",
    );
  }
  const binding = input.exception.bindings.find(
    (candidate) => candidate.actionClass === input.actionClass,
  );
  if (!binding || binding.sourceSha !== input.applicationSourceSha) {
    throw new ControlPlaneError(
      "dependency audit 예외의 exact source binding이 runtime 요청과 일치하지 않습니다.",
      409,
      "DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH",
    );
  }
  const expiresAt = Date.parse(input.exception.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime()) {
    throw new ControlPlaneError(
      "dependency audit 예외가 만료되었습니다.",
      409,
      "DEPENDENCY_AUDIT_EXCEPTION_EXPIRED",
    );
  }
  return input.exception;
}

export const MAX_OBSERVATION_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export async function readRepositoryDefaultBranch(repoId: bigint): Promise<string> {
  const registration = await prisma.repositoryRegistration.findUnique({
    where: { repoId },
    select: { archived: true, defaultBranch: true },
  });
  const defaultBranch = registration?.defaultBranch ?? null;
  if (registration?.archived || !repositoryDefaultBranchRef(defaultBranch)) {
    throw new ControlPlaneError(
      "GitHub provider에서 확인한 repository default branch가 없습니다.",
      409,
      "REPOSITORY_DEFAULT_BRANCH_NOT_READY",
    );
  }
  return defaultBranch!;
}

/** caller clock 오류가 event-time latest pointer를 영구 오염시키지 못하게 한다. */
export function assertObservationTime(
  observedAt: Date,
  receivedAt = new Date(),
): void {
  const observedTime = observedAt.getTime();
  const receivedTime = receivedAt.getTime();
  if (
    !Number.isFinite(observedTime)
    || !Number.isFinite(receivedTime)
    || observedTime > receivedTime + MAX_OBSERVATION_FUTURE_SKEW_MS
  ) {
    throw new ControlPlaneError(
      "observation 시각이 서버 수신 시각의 허용 범위를 벗어났습니다.",
      400,
      "OBSERVED_AT_FUTURE",
    );
  }
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function appForRepoId(
  client: Prisma.TransactionClient | typeof prisma,
  repoId: bigint,
) {
  const app = await client.app.findUnique({
    where: { repoId },
    select: { id: true, repoId: true, repoFullName: true, slug: true },
  });
  if (!app) throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  return app;
}

function assertIdempotentPayload(
  storedHash: string,
  payloadHash: string,
): void {
  if (storedHash !== payloadHash) {
    throw new ControlPlaneError(
      "같은 idempotency key가 다른 payload에 사용되었습니다.",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
}

export function assertIdempotentRequestHash(storedHash: string | null, requestHash: string): void {
  if (storedHash !== requestHash) {
    throw new ControlPlaneError(
      "같은 idempotency key가 다른 전체 요청에 사용되었습니다.",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
}

export function discoveryObservationRequestHash(input: {
  repoId: bigint;
  sourceSha: string;
  sourceRef?: string;
  observedAt: Date;
  observedBy: string;
  workflowCaller: WorkflowCaller;
  buildBindings?: AndroidBuildBindingObservation[];
  payload: Record<string, unknown>;
  buildTargets: Array<{
    targetKey: string;
    stack: string;
    market?: string;
    packageId?: string | null;
    bundleId?: string | null;
    configuration?: Record<string, unknown> | null;
  }>;
}): string {
  return jsonDigest({
    repoId: input.repoId.toString(),
    sourceSha: input.sourceSha.toLowerCase(),
    sourceRef: input.sourceRef ?? null,
    observedAt: input.observedAt.toISOString(),
    observedBy: input.observedBy,
    workflowCaller: input.workflowCaller,
    ...(input.buildBindings === undefined ? {} : { buildBindings: input.buildBindings }),
    payload: input.payload,
    buildTargets: input.buildTargets.map((target) => ({
      targetKey: target.targetKey,
      stack: target.stack,
      market: target.market?.toLowerCase() ?? null,
      packageId: target.packageId ?? null,
      bundleId: target.bundleId ?? null,
      configuration: target.configuration ?? null,
    })),
  } as JsonValue);
}

export function providerObservationRequestHash(input: {
  repoId: bigint;
  provider: string;
  resourceType: string;
  resourceId: string;
  observedAt: Date;
  observedBy: string;
  payload: Record<string, unknown>;
  externalBinding?: {
    bindingType: string;
    externalId: string;
    publicIdentity?: string;
    metadata?: Record<string, unknown>;
  };
}): string {
  return jsonDigest({
    repoId: input.repoId.toString(),
    provider: input.provider.toLowerCase(),
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    observedAt: input.observedAt.toISOString(),
    observedBy: input.observedBy,
    payload: input.payload,
    externalBinding: input.externalBinding
      ? {
          bindingType: input.externalBinding.bindingType,
          externalId: input.externalBinding.externalId,
          publicIdentity: input.externalBinding.publicIdentity ?? null,
          metadata: input.externalBinding.metadata ?? null,
        }
      : null,
  } as JsonValue);
}

export function assertConfigRevisionPayload(payload: unknown): asserts payload is Record<string, unknown> {
  const validated = configRevisionPayloadSchema.safeParse(payload);
  if (validated.success) return;
  const paths = validated.error.issues.map((issue) => issue.path.join(".")).filter(Boolean);
  throw new ControlPlaneError(
    `허용된 비민감 Config 계약 밖의 필드 또는 값은 별도 사람 승인 workflow가 필요합니다: ${paths.join(", ") || "unknown"}`,
    403,
    "HUMAN_APPROVAL_REQUIRED",
  );
}

export const CONFIG_REVISION_MANUAL_SOURCE_CONTRACT_VERSION =
  "config-revision-manual-source/v1";
export const CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION =
  "config-revision-source-rebase/v1";
export const CONFIG_REVISION_SOURCE_AUTO_REBASE_CONTRACT_VERSION =
  "config-revision-source-auto-rebase/v1";
export const CONFIG_REVISION_DISCOVERY_PROJECTION_CONTRACT_VERSION =
  "config-revision-discovery-projection/v2";

const SHA_40 = /^[0-9a-f]{40}$/;
const DIGEST_64 = /^[0-9a-f]{64}$/;

type ConfigSourceApp = {
  id: string;
  repoId: bigint | null;
  repoFullName: string;
  status: "ACTIVE" | "PAUSED" | "DEPRECATED";
};

type ConfigSourceRegistration = {
  repoId: bigint;
  repoFullName: string;
  defaultBranch: string | null;
  archived: boolean;
  status: string;
  classification: string | null;
  discoveryContractVersion: string | null;
  lastDefaultPushSha: string | null;
  lastReconciledSha: string | null;
};

type ConfigSourceObservation = {
  id: string;
  appId: string;
  sourceSha: string;
  sourceRef: string | null;
  payload: unknown;
  payloadHash: string;
  requestHash: string | null;
};

/** DB row 자체의 app/ref/SHA/payload provenance가 훼손되면 replay도 거부한다. */
export function assertConfigSourceObservationIntegrity(input: {
  appId: string;
  repoId: bigint;
  expectedSourceRef?: string;
  observation: ConfigSourceObservation;
}): void {
  const payload = jsonRecord(input.observation.payload);
  const repository = jsonRecord(payload?.repository);
  const expectedSourceRef = input.expectedSourceRef ?? input.observation.sourceRef;
  if (
    input.observation.appId !== input.appId
    || !expectedSourceRef?.startsWith("refs/heads/")
    || input.observation.sourceRef !== expectedSourceRef
    || !SHA_40.test(input.observation.sourceSha)
    || !DIGEST_64.test(input.observation.payloadHash)
    || !DIGEST_64.test(input.observation.requestHash ?? "")
    || jsonDigest(input.observation.payload as JsonValue) !== input.observation.payloadHash
    || payload?.schemaVersion !== 2
    || payload?.contractVersion !== REPOSITORY_DISCOVERY_CONTRACT_VERSION
    || payload?.status !== "ACTIVE"
    || payload?.classification !== "PRODUCT_APP"
    || typeof repository?.id !== "number"
    || !Number.isSafeInteger(repository.id)
    || BigInt(repository.id) !== input.repoId
    || repository.sourceRef !== input.observation.sourceRef
    || repository.sourceSha !== input.observation.sourceSha
  ) {
    throw new ControlPlaneError(
      "Config source discovery의 app/ref/SHA/payload provenance가 유효하지 않습니다.",
      409,
      "CONFIG_SOURCE_PROVENANCE_INVALID",
    );
  }
}

/** caller가 source를 고르지 못하게 서버가 고른 최신 observation과 등록 원장을 결합한다. */
function assertExactConfigSourceBinding(input: {
  app: ConfigSourceApp;
  registration: ConfigSourceRegistration | null;
  observation: ConfigSourceObservation | null;
}, allowedAppStatuses: ReadonlySet<ConfigSourceApp["status"]>): void {
  const { app, registration, observation } = input;
  if (!app.repoId || !registration || !observation) {
    throw new ControlPlaneError(
      "관리 등록 또는 latest discovery가 없습니다.",
      409,
      "CONFIG_SOURCE_NOT_READY",
    );
  }
  const sourceSha = observation.sourceSha;
  const expectedSourceRef = repositoryDefaultBranchRef(registration.defaultBranch);
  if (
    !allowedAppStatuses.has(app.status)
    || registration.repoId !== app.repoId
    || registration.repoFullName.toLowerCase() !== app.repoFullName.toLowerCase()
    || registration.archived
    || registration.status !== "MANAGED"
    || registration.classification !== "PRODUCT_APP"
    || expectedSourceRef === null
    || registration.discoveryContractVersion !== REPOSITORY_DISCOVERY_CONTRACT_VERSION
    || registration.lastDefaultPushSha?.toLowerCase() !== sourceSha
    || registration.lastReconciledSha?.toLowerCase() !== sourceSha
  ) {
    throw new ControlPlaneError(
      "Repository registration과 latest default-branch discovery가 exact source로 수렴하지 않았습니다.",
      409,
      "CONFIG_SOURCE_NOT_CURRENT",
    );
  }
  assertConfigSourceObservationIntegrity({
    appId: app.id,
    repoId: app.repoId,
    expectedSourceRef,
    observation,
  });
  const repository = jsonRecord(jsonRecord(observation.payload)?.repository);
  if (
    repository?.fullName !== app.repoFullName
    || repository?.fullName !== registration.repoFullName
  ) {
    throw new ControlPlaneError(
      "Discovery repository identity가 App 및 registration binding과 일치하지 않습니다.",
      409,
      "CONFIG_SOURCE_APP_MISMATCH",
    );
  }
}

export function assertCurrentConfigSourceBinding(input: {
  app: ConfigSourceApp;
  registration: ConfigSourceRegistration | null;
  observation: ConfigSourceObservation | null;
}): asserts input is {
  app: ConfigSourceApp & { repoId: bigint; status: "ACTIVE" };
  registration: ConfigSourceRegistration;
  observation: ConfigSourceObservation;
} {
  assertExactConfigSourceBinding(input, new Set(["ACTIVE"]));
}

/**
 * 중앙 managed PRODUCT_APP cohort는 lifecycle이 중단된 앱도 inventory와 source-only
 * revision 재결합에서 빠뜨리지 않는다. archived/non-product와 exact source drift는
 * ACTIVE 앱과 동일하게 fail-closed한다.
 */
export function assertManagedProductConfigSourceBinding(input: {
  app: ConfigSourceApp;
  registration: ConfigSourceRegistration | null;
  observation: ConfigSourceObservation | null;
}): asserts input is {
  app: ConfigSourceApp & { repoId: bigint };
  registration: ConfigSourceRegistration;
  observation: ConfigSourceObservation;
} {
  assertExactConfigSourceBinding(input, new Set(["ACTIVE", "PAUSED", "DEPRECATED"]));
}

export function assertExpectedLatestConfigRevision(input: {
  expectedLatestRevision: number;
  actualLatestRevision: number;
}): void {
  if (input.expectedLatestRevision !== input.actualLatestRevision) {
    throw new ControlPlaneError(
      `Config revision 충돌: expected=${input.expectedLatestRevision}, actual=${input.actualLatestRevision}`,
      409,
      "REVISION_CONFLICT",
    );
  }
}

export function assertExpectedConfigSourceSha(input: {
  expectedSourceSha?: string;
  actualSourceSha: string;
}): void {
  if (
    input.expectedSourceSha !== undefined
    && input.expectedSourceSha !== input.actualSourceSha
  ) {
    throw new ControlPlaneError(
      `Config source SHA 충돌: expected=${input.expectedSourceSha}, actual=${input.actualSourceSha}`,
      409,
      "CONFIG_SOURCE_SHA_MISMATCH",
    );
  }
}

type ConfigRevisionReplay = {
  revision: number;
  appId: string;
  sourceObservationId: string | null;
  payload: unknown;
  payloadHash: string;
  createdBy: string;
  backfillContractVersion: string | null;
  app: { id: string; repoId: bigint | null };
  sourceObservation: ConfigSourceObservation | null;
};

/** 별도 requestHash column 없이도 모든 caller 입력을 immutable row identity로 검증한다. */
export function assertConfigRevisionReplay(input: {
  stored: ConfigRevisionReplay;
  repoId: bigint;
  actor: string;
  expectedLatestRevision: number;
  contractVersion: string | null;
  payloadHash?: string;
  expectedSourceSha?: string;
}): void {
  const { stored } = input;
  if (
    stored.app.id !== stored.appId
    || stored.app.repoId !== input.repoId
    || stored.createdBy !== input.actor
    || stored.revision !== input.expectedLatestRevision + 1
    || stored.backfillContractVersion !== input.contractVersion
    || stored.sourceObservationId !== stored.sourceObservation?.id
    || (input.payloadHash !== undefined && stored.payloadHash !== input.payloadHash)
    || (input.expectedSourceSha !== undefined
      && stored.sourceObservation?.sourceSha !== input.expectedSourceSha)
    || !DIGEST_64.test(stored.payloadHash)
    || jsonDigest(stored.payload as JsonValue) !== stored.payloadHash
  ) {
    throw new ControlPlaneError(
      "같은 idempotency key가 다른 config revision 요청에 사용되었습니다.",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
  assertConfigRevisionPayload(stored.payload);
  if (!stored.sourceObservation) {
    throw new ControlPlaneError(
      "idempotent config revision의 source provenance가 없습니다.",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
  try {
    assertConfigSourceObservationIntegrity({
      appId: stored.appId,
      repoId: input.repoId,
      observation: stored.sourceObservation,
    });
  } catch {
    throw new ControlPlaneError(
      "idempotent config revision의 source provenance가 일치하지 않습니다.",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
}

export function assertConfigRevisionRebaseSource(input: {
  status: string;
  idempotencyKey: string;
  legacyConfigImport: { id: string } | null;
}): void {
  if (
    !["DRAFT", "ACTIVE"].includes(input.status)
    || input.legacyConfigImport
    || input.idempotencyKey.startsWith("legacy-shadow-draft:")
  ) {
    throw new ControlPlaneError(
      "latest DRAFT 또는 ACTIVE revision만 source rebase할 수 있습니다.",
      409,
      "CONFIG_REVISION_NOT_REBASABLE",
    );
  }
}

export function configSourceBindingsMatch(
  left: Pick<ConfigSourceObservation, "appId" | "sourceRef" | "sourceSha" | "payloadHash"> | null,
  right: Pick<ConfigSourceObservation, "appId" | "sourceRef" | "sourceSha" | "payloadHash">,
): boolean {
  return Boolean(
    left
    && left.appId === right.appId
    && left.sourceRef === right.sourceRef
    && left.sourceSha === right.sourceSha
    && left.payloadHash === right.payloadHash
  );
}

export type ConfigSourceAutoRebaseNeedsInputReason =
  | "ACTIVE_CONFIG_MISSING"
  | "ACTIVE_SNAPSHOT_INVALID"
  | "BUILD_TARGET_MARKET_CHANGED"
  | "DESIRED_PAYLOAD_CHANGED"
  | "LEGACY_DRAFT_REQUIRES_INPUT";

type SourceRebaseBuildTarget = {
  market: string | null;
  observedSha: string | null;
};

/**
 * 자동 활성화는 current source에서 확인된 market 집합과 서명된 ACTIVE payload가
 * 완전히 같은 경우에만 허용한다. locale, 법적 선언, asset, cloud/provider 설정은
 * discovery가 판단하지 않고 payload 전체 digest 동일성으로 변경 0건을 강제한다.
 */
export function assessConfigSourceAutoRebaseSafety(input: {
  sourceSha: string;
  activePayload: Record<string, unknown>;
  desiredPayload: Record<string, unknown>;
  buildTargets: SourceRebaseBuildTarget[];
}): ConfigSourceAutoRebaseNeedsInputReason | null {
  const active = configRevisionPayloadSchema.parse(input.activePayload);
  const desired = configRevisionPayloadSchema.parse(input.desiredPayload);
  if (
    jsonDigest(active as unknown as JsonValue)
    !== jsonDigest(desired as unknown as JsonValue)
  ) {
    return "DESIRED_PAYLOAD_CHANGED";
  }

  const enabledMarkets = active.markets
    .filter((profile) => profile.enabled)
    .map((profile) => profile.market)
    .sort();
  const currentMarketCounts = new Map<string, number>();
  for (const target of input.buildTargets) {
    if (
      target.observedSha?.toLowerCase() !== input.sourceSha.toLowerCase()
      || !BUILD_TARGET_MARKETS.includes(target.market as BuildTargetMarket)
    ) continue;
    currentMarketCounts.set(target.market!, (currentMarketCounts.get(target.market!) ?? 0) + 1);
  }
  const currentMarkets = [...currentMarketCounts.keys()].sort();
  if (
    enabledMarkets.length !== currentMarkets.length
    || enabledMarkets.some((market, index) => market !== currentMarkets[index])
    || enabledMarkets.some((market) => currentMarketCounts.get(market) !== 1)
  ) {
    return "BUILD_TARGET_MARKET_CHANGED";
  }
  return null;
}

export function isLegacyDiscoveryProjectionSource(input: {
  revisionId: string;
  status: string;
  idempotencyKey: string;
  legacyConfigImport: {
    id: string;
    configRevisionId: string | null;
    status: string;
    transformVersion: string;
    parityObservations: Array<{ id: string; status: string; contractVersion: string }>;
  } | null;
}): boolean {
  const legacyImport = input.legacyConfigImport;
  return input.status === "DRAFT"
    && input.idempotencyKey.startsWith("legacy-shadow-draft:")
    && legacyImport !== null
    && legacyImport.configRevisionId === input.revisionId
    && ["DRAFT_CREATED", "DRAFT_CREATED_WITH_INPUT"].includes(legacyImport.status)
    && legacyImport.parityObservations.length === 1
    && legacyImport.parityObservations[0]?.contractVersion === legacyImport.transformVersion;
}

type LegacyDiscoveryProjectionRevision = Parameters<typeof isLegacyDiscoveryProjectionSource>[0];

export type DiscoveryProjectionSource =
  | { kind: "EMPTY_CONFIG" }
  | {
      kind: "LEGACY_IMPORT";
      revision: LegacyDiscoveryProjectionRevision;
      legacyImport: NonNullable<LegacyDiscoveryProjectionRevision["legacyConfigImport"]>;
      parity: NonNullable<LegacyDiscoveryProjectionRevision["legacyConfigImport"]>["parityObservations"][number];
    };

/**
 * 기존 revision을 복제하지 않는 projection의 유일한 두 source를 고정한다.
 * lifecycle이 PAUSED/DEPRECATED인 앱은 revision과 legacy import가 모두 0인 경우만 허용한다.
 */
export function resolveDiscoveryProjectionSource(input: {
  appStatus: ConfigSourceApp["status"];
  actualLatestRevision: number;
  legacyImportCount: number;
  fromRevision: LegacyDiscoveryProjectionRevision | null;
}): DiscoveryProjectionSource {
  if (
    input.actualLatestRevision === 0
    && input.fromRevision === null
    && input.legacyImportCount === 0
  ) {
    return { kind: "EMPTY_CONFIG" };
  }
  if (
    input.appStatus === "ACTIVE"
    && input.actualLatestRevision > 0
    && input.fromRevision !== null
    && isLegacyDiscoveryProjectionSource(input.fromRevision)
  ) {
    const legacyImport = input.fromRevision.legacyConfigImport;
    const parity = legacyImport?.parityObservations[0];
    if (!legacyImport || !parity) throw new Error("legacy projection invariant");
    return { kind: "LEGACY_IMPORT", revision: input.fromRevision, legacyImport, parity };
  }
  throw new ControlPlaneError(
    "revision 0/no-import 또는 검증된 latest legacy shadow DRAFT만 discovery projection할 수 있습니다.",
    409,
    "DISCOVERY_PROJECTION_NOT_ALLOWED",
  );
}

export function assertActivationPreconditions(input: {
  actualActiveRevision: number;
  expectedActiveRevision: number;
  targetStatus: "DRAFT" | "ACTIVE" | "SUPERSEDED";
  shadowImportId?: string | null;
}): void {
  if (input.shadowImportId) {
    throw new ControlPlaneError(
      "Legacy shadow import가 만든 DRAFT는 직접 활성화할 수 없습니다.",
      409,
      "SHADOW_IMPORT_NOT_ACTIVATABLE",
    );
  }
  if (input.actualActiveRevision !== input.expectedActiveRevision) {
    throw new ControlPlaneError(
      `ACTIVE revision 충돌: expected=${input.expectedActiveRevision}, actual=${input.actualActiveRevision}`,
      409,
      "REVISION_CONFLICT",
    );
  }
  if (input.targetStatus !== "DRAFT") {
    throw new ControlPlaneError("DRAFT revision만 활성화할 수 있습니다.", 409, "IMMUTABLE_REVISION");
  }
}

export function resolvedWorkflowCaller(input: {
  profile: string | null;
  packageManager: string | null;
  workingDirectory: string | null;
}): WorkflowCaller {
  const result = workflowCallerSchema.safeParse({
    profile: input.profile,
    packageManager: input.packageManager,
    workingDirectory: input.workingDirectory,
  });
  if (result.success) return result.data;
  throw new ControlPlaneError(
    "요청한 source SHA의 workflow caller 탐지 결과가 없거나 모호합니다.",
    409,
    "NO_WORKFLOW_CALLER_FOR_SHA",
  );
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function observedStaticWorkspaceRoot(input: {
  payload: unknown;
  caller: WorkflowCaller;
  repositoryId: string;
  fullName: string;
  sourceSha: string;
  sourceRef: string;
}): string {
  if (input.caller.profile === "godot" || input.caller.workingDirectory === ".") {
    return input.caller.workingDirectory;
  }
  const payload = jsonRecord(input.payload);
  const repository = jsonRecord(payload?.repository);
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  if (
    payload?.schemaVersion !== 2
    || (
      payload?.contractVersion !== "repository-discovery/v7"
      && payload?.contractVersion !== REPOSITORY_DISCOVERY_CONTRACT_VERSION
    )
    || String(repository?.id ?? "") !== input.repositoryId
    || repository?.fullName !== input.fullName
    || repository?.sourceSha !== input.sourceSha
    || repository?.sourceRef !== input.sourceRef
  ) {
    return input.caller.workingDirectory;
  }
  const lockPath = input.caller.packageManager === "pnpm"
    ? "pnpm-lock.yaml"
    : "package-lock.json";
  const observedAtRoot = (expectedPath: string) => sources.some((value) => {
    const source = jsonRecord(value);
    return source?.path === expectedPath
      && source.status === "PRESENT"
      && source.reason === null
      && String(source.repoId ?? "") === input.repositoryId
      && source.fullName === input.fullName
      && source.sourceSha === input.sourceSha
      && source.sourceRef === input.sourceRef
      && /^[0-9a-f]{40}$/.test(String(source.blobSha ?? ""))
      && /^[0-9a-f]{64}$/.test(String(source.contentSha256 ?? ""));
  });
  return observedAtRoot("package.json") && observedAtRoot(lockPath)
    ? "."
    : input.caller.workingDirectory;
}

export type DiscoveryObservationInput = {
  repoId: bigint;
  sourceSha: string;
  sourceRef?: string;
  observedAt: Date;
  observedBy: string;
  idempotencyKey: string;
  workflowCaller: WorkflowCaller;
  buildBindings?: AndroidBuildBindingObservation[];
  payload: Record<string, unknown>;
  buildTargets: Array<{
    targetKey: string;
    stack: string;
    market?: string;
    packageId?: string | null;
    bundleId?: string | null;
    configuration?: Record<string, unknown> | null;
  }>;
};

/**
 * Repository discovery reconciler가 App 등록, observation, registration 상태를
 * 하나의 row-lock transaction으로 닫을 수 있게 하는 내부 service 경계다.
 */
export async function recordDiscoveryObservationInTransaction(
  tx: Prisma.TransactionClient,
  input: DiscoveryObservationInput,
) {
  assertObservationTime(input.observedAt);
  const payloadHash = jsonDigest(input.payload as JsonValue);
  const requestHash = discoveryObservationRequestHash(input);
  const replay = await tx.discoveryObservation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    assertIdempotentRequestHash(replay.requestHash, requestHash);
    assertIdempotentPayload(replay.payloadHash, payloadHash);
    if (replay.app.repoId !== input.repoId || replay.sourceSha !== input.sourceSha.toLowerCase()) {
      throw new ControlPlaneError("idempotency key가 다른 discovery 요청에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    if (
      replay.workflowProfile !== input.workflowCaller.profile
      || replay.workflowPackageManager !== input.workflowCaller.packageManager
      || replay.workflowWorkingDirectory !== input.workflowCaller.workingDirectory
      || jsonDigest((replay.buildBindings ?? []) as JsonValue)
        !== jsonDigest((input.buildBindings ?? []) as JsonValue)
    ) {
      throw new ControlPlaneError("idempotency key가 다른 workflow caller에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { observation: replay, duplicate: true };
  }

  const app = await appForRepoId(tx, input.repoId);
  const observation = await tx.discoveryObservation.create({
    data: {
      appId: app.id,
      sourceSha: input.sourceSha.toLowerCase(),
      sourceRef: input.sourceRef,
      workflowProfile: input.workflowCaller.profile,
      workflowPackageManager: input.workflowCaller.packageManager,
      workflowWorkingDirectory: input.workflowCaller.workingDirectory,
      buildBindings: input.buildBindings?.length
        ? jsonInput(input.buildBindings)
        : Prisma.DbNull,
      observedAt: input.observedAt,
      observedBy: input.observedBy,
      idempotencyKey: input.idempotencyKey,
      payload: jsonInput(input.payload),
      payloadHash,
      requestHash,
    },
  });
  for (const target of input.buildTargets) {
    const market = target.market?.toLowerCase();
    await tx.buildTarget.upsert({
      where: { appId_targetKey: { appId: app.id, targetKey: target.targetKey } },
      create: {
        appId: app.id,
        targetKey: target.targetKey,
        stack: target.stack,
        market,
        packageId: target.packageId ?? null,
        bundleId: target.bundleId ?? null,
        observedSha: input.sourceSha.toLowerCase(),
        observedAt: input.observedAt,
        configuration: target.configuration ? jsonInput(target.configuration) : Prisma.DbNull,
      },
      update: {},
    });
    await tx.buildTarget.updateMany({
      where: {
        appId: app.id,
        targetKey: target.targetKey,
        observedAt: { lte: input.observedAt },
      },
      data: {
        stack: target.stack,
        market,
        packageId: target.packageId ?? null,
        bundleId: target.bundleId ?? null,
        observedSha: input.sourceSha.toLowerCase(),
        observedAt: input.observedAt,
        configuration: target.configuration ? jsonInput(target.configuration) : Prisma.DbNull,
      },
    });
  }
  await tx.auditLog.create({
    data: {
      actorLogin: input.observedBy,
      action: "control-plane.discovery.record",
      entityType: "DiscoveryObservation",
      entityId: observation.id,
      payload: {
        appId: app.id,
        sourceSha: input.sourceSha,
        payloadHash,
        workflowCaller: input.workflowCaller,
      },
    },
  });
  return { observation, duplicate: false };
}

export async function recordDiscoveryObservation(input: DiscoveryObservationInput) {
  return prisma.$transaction((tx) => recordDiscoveryObservationInTransaction(tx, input));
}

export async function recordProviderObservation(input: {
  repoId: bigint;
  provider: string;
  resourceType: string;
  resourceId: string;
  observedAt: Date;
  observedBy: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  externalBinding?: {
    bindingType: string;
    externalId: string;
    publicIdentity?: string;
    metadata?: Record<string, unknown>;
  };
}) {
  assertObservationTime(input.observedAt);
  const provider = input.provider.toLowerCase();
  const payloadHash = jsonDigest(input.payload as JsonValue);
  const requestHash = providerObservationRequestHash(input);
  const replay = await prisma.providerObservation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    assertIdempotentRequestHash(replay.requestHash, requestHash);
    assertIdempotentPayload(replay.payloadHash, payloadHash);
    if (
      replay.app.repoId !== input.repoId
      || replay.provider !== provider
      || replay.resourceType !== input.resourceType
      || replay.resourceId !== input.resourceId
    ) {
      throw new ControlPlaneError("idempotency key가 다른 provider 요청에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { observation: replay, duplicate: true };
  }
  return prisma.$transaction(async (tx) => {
    const app = await appForRepoId(tx, input.repoId);
    const observation = await tx.providerObservation.create({
      data: {
        appId: app.id,
        provider,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        payload: jsonInput(input.payload),
        payloadHash,
        requestHash,
        observedBy: input.observedBy,
        observedAt: input.observedAt,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (input.externalBinding) {
      const binding = input.externalBinding;
      await tx.externalBinding.upsert({
        where: {
          provider_bindingType_externalId: {
            provider,
            bindingType: binding.bindingType,
            externalId: binding.externalId,
          },
        },
        create: {
          appId: app.id,
          provider,
          bindingType: binding.bindingType,
          externalId: binding.externalId,
          publicIdentity: binding.publicIdentity,
          metadata: binding.metadata ? jsonInput(binding.metadata) : undefined,
          observedAt: input.observedAt,
        },
        update: {},
      });
      await tx.externalBinding.updateMany({
        where: {
          provider,
          bindingType: binding.bindingType,
          externalId: binding.externalId,
          observedAt: { lte: input.observedAt },
        },
        data: {
          appId: app.id,
          publicIdentity: binding.publicIdentity,
          metadata: binding.metadata ? jsonInput(binding.metadata) : Prisma.JsonNull,
          observedAt: input.observedAt,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        actorLogin: input.observedBy,
        action: "control-plane.provider.record",
        entityType: "ProviderObservation",
        entityId: observation.id,
        payload: {
          appId: app.id,
          provider,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          payloadHash,
        },
      },
    });
    return { observation, duplicate: false };
  });
}

const configRevisionReplayInclude = Prisma.validator<Prisma.ConfigRevisionInclude>()({
  app: { select: { id: true, repoId: true } },
  sourceObservation: {
    select: {
      id: true,
      appId: true,
      sourceSha: true,
      sourceRef: true,
      payload: true,
      payloadHash: true,
      requestHash: true,
    },
  },
});

async function configRevisionReplayForKey(
  client: Prisma.TransactionClient | typeof prisma,
  idempotencyKey: string,
) {
  return client.configRevision.findUnique({
    where: { idempotencyKey },
    include: configRevisionReplayInclude,
  });
}

async function lockedCurrentConfigSource(
  tx: Prisma.TransactionClient,
  repoId: bigint,
  options: { managedProductLifecycle?: boolean } = {},
) {
  // discovery reconciler와 동일하게 registration -> app 순으로 잠가 교착을 피한다.
  await tx.$queryRaw`SELECT repoId FROM repository_registration WHERE repoId = ${repoId} FOR UPDATE`;
  const initialApp = await tx.app.findUnique({
    where: { repoId },
    select: { id: true },
  });
  if (!initialApp) {
    throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  }
  await tx.$queryRaw`SELECT id FROM app WHERE id = ${initialApp.id} FOR UPDATE`;
  const app = await tx.app.findUniqueOrThrow({
    where: { id: initialApp.id },
    select: { id: true, repoId: true, repoFullName: true, status: true },
  });
  const registration = await tx.repositoryRegistration.findUnique({
    where: { repoId },
    select: {
      repoId: true,
      repoFullName: true,
      defaultBranch: true,
      archived: true,
      status: true,
      classification: true,
      discoveryContractVersion: true,
      lastDefaultPushSha: true,
      lastReconciledSha: true,
    },
  });
  const observation = await tx.discoveryObservation.findFirst({
    where: { appId: app.id },
    orderBy: latestDiscoveryObservationOrder(),
    select: {
      id: true,
      appId: true,
      sourceSha: true,
      sourceRef: true,
      payload: true,
      payloadHash: true,
      requestHash: true,
    },
  });
  const binding = { app, registration, observation };
  if (options.managedProductLifecycle) {
    assertManagedProductConfigSourceBinding(binding);
  } else {
    assertCurrentConfigSourceBinding(binding);
  }
  return binding;
}

async function latestConfigRevisionNumber(
  tx: Prisma.TransactionClient,
  appId: string,
): Promise<number> {
  const latest = await tx.configRevision.aggregate({
    where: { appId },
    _max: { revision: true },
  });
  return latest._max.revision ?? 0;
}

type ConfigRevisionMutationIdentity = {
  repoId: bigint;
  actor: string;
  expectedLatestRevision: number;
  idempotencyKey: string;
  contractVersion: string | null;
  payloadHash?: string;
  expectedSourceSha?: string;
};

async function runConfigRevisionMutation(
  identity: ConfigRevisionMutationIdentity,
  mutation: () => Promise<{
    revision: ConfigRevision;
    sourceObservation: NonNullable<ConfigRevisionReplay["sourceObservation"]>;
    duplicate: boolean;
  }>,
) {
  try {
    return await mutation();
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    const replay = await configRevisionReplayForKey(prisma, identity.idempotencyKey);
    if (!replay) throw error;
    assertConfigRevisionReplay({ stored: replay, ...identity });
    return { revision: replay, sourceObservation: replay.sourceObservation!, duplicate: true };
  }
}

export async function createConfigRevision(input: {
  repoId: bigint;
  expectedLatestRevision: number;
  payload: Record<string, unknown>;
  actor: string;
  idempotencyKey: string;
  expectedSourceSha?: string;
}) {
  assertConfigRevisionPayload(input.payload);
  const payloadHash = jsonDigest(input.payload as JsonValue);
  const replay = await configRevisionReplayForKey(prisma, input.idempotencyKey);
  if (replay) {
    assertConfigRevisionReplay({
      stored: replay,
      repoId: input.repoId,
      actor: input.actor,
      expectedLatestRevision: input.expectedLatestRevision,
      contractVersion: null,
      payloadHash,
      expectedSourceSha: input.expectedSourceSha,
    });
    return { revision: replay, sourceObservation: replay.sourceObservation!, duplicate: true };
  }

  return runConfigRevisionMutation({
    repoId: input.repoId,
    actor: input.actor,
    expectedLatestRevision: input.expectedLatestRevision,
    idempotencyKey: input.idempotencyKey,
    contractVersion: null,
    payloadHash,
    expectedSourceSha: input.expectedSourceSha,
  }, () => prisma.$transaction(async (tx) => {
    const source = await lockedCurrentConfigSource(tx, input.repoId);
    const afterLockReplay = await configRevisionReplayForKey(tx, input.idempotencyKey);
    if (afterLockReplay) {
      assertConfigRevisionReplay({
        stored: afterLockReplay,
        repoId: input.repoId,
        actor: input.actor,
        expectedLatestRevision: input.expectedLatestRevision,
        contractVersion: null,
        payloadHash,
        expectedSourceSha: input.expectedSourceSha,
      });
      return {
        revision: afterLockReplay,
        sourceObservation: afterLockReplay.sourceObservation!,
        duplicate: true,
      };
    }
    assertExpectedConfigSourceSha({
      expectedSourceSha: input.expectedSourceSha,
      actualSourceSha: source.observation.sourceSha,
    });
    assertExpectedLatestConfigRevision({
      expectedLatestRevision: input.expectedLatestRevision,
      actualLatestRevision: await latestConfigRevisionNumber(tx, source.app.id),
    });
    const revision = await createDraftRevisionInTransaction(tx, {
      appId: source.app.id,
      payload: input.payload,
      payloadHash,
      createdBy: input.actor,
      idempotencyKey: input.idempotencyKey,
      sourceObservationId: source.observation.id,
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.config.create",
        entityType: "ConfigRevision",
        entityId: revision.id,
        payload: {
          appId: source.app.id,
          repoId: input.repoId.toString(),
          revision: revision.revision,
          expectedLatestRevision: input.expectedLatestRevision,
          payloadHash,
          sourceObservationId: source.observation.id,
          sourceSha: source.observation.sourceSha,
          expectedSourceSha: input.expectedSourceSha ?? null,
          observationPayloadHash: source.observation.payloadHash,
          contractVersion: CONFIG_REVISION_MANUAL_SOURCE_CONTRACT_VERSION,
          activationAttempted: false,
        },
      },
    });
    return { revision, sourceObservation: source.observation, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function rebaseLatestConfigRevisionSource(input: {
  repoId: bigint;
  expectedLatestRevision: number;
  actor: string;
  idempotencyKey: string;
}) {
  const replay = await configRevisionReplayForKey(prisma, input.idempotencyKey);
  if (replay) {
    assertConfigRevisionReplay({
      stored: replay,
      repoId: input.repoId,
      actor: input.actor,
      expectedLatestRevision: input.expectedLatestRevision,
      contractVersion: CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION,
    });
    return { revision: replay, sourceObservation: replay.sourceObservation!, duplicate: true };
  }

  return runConfigRevisionMutation({
    repoId: input.repoId,
    actor: input.actor,
    expectedLatestRevision: input.expectedLatestRevision,
    idempotencyKey: input.idempotencyKey,
    contractVersion: CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION,
  }, () => prisma.$transaction(async (tx) => {
    const source = await lockedCurrentConfigSource(tx, input.repoId);
    const afterLockReplay = await configRevisionReplayForKey(tx, input.idempotencyKey);
    if (afterLockReplay) {
      assertConfigRevisionReplay({
        stored: afterLockReplay,
        repoId: input.repoId,
        actor: input.actor,
        expectedLatestRevision: input.expectedLatestRevision,
        contractVersion: CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION,
      });
      return {
        revision: afterLockReplay,
        sourceObservation: afterLockReplay.sourceObservation!,
        duplicate: true,
      };
    }
    const actualLatestRevision = await latestConfigRevisionNumber(tx, source.app.id);
    assertExpectedLatestConfigRevision({
      expectedLatestRevision: input.expectedLatestRevision,
      actualLatestRevision,
    });
    const fromRevision = await tx.configRevision.findUnique({
      where: {
        appId_revision: {
          appId: source.app.id,
          revision: actualLatestRevision,
        },
      },
      include: {
        legacyConfigImport: { select: { id: true } },
        sourceObservation: {
          select: {
            id: true,
            appId: true,
            sourceSha: true,
            sourceRef: true,
            payload: true,
            payloadHash: true,
            requestHash: true,
          },
        },
      },
    });
    if (!fromRevision) {
      throw new ControlPlaneError(
        "재결합할 기존 Config revision이 없습니다.",
        409,
        "CONFIG_REVISION_REBASE_SOURCE_MISSING",
      );
    }
    assertConfigRevisionRebaseSource(fromRevision);
    assertConfigRevisionPayload(fromRevision.payload);
    if (
      !DIGEST_64.test(fromRevision.payloadHash)
      || jsonDigest(fromRevision.payload as JsonValue) !== fromRevision.payloadHash
    ) {
      throw new ControlPlaneError(
        "기존 Config revision payload가 저장 digest와 일치하지 않습니다.",
        409,
        "CONFIG_REVISION_PAYLOAD_DRIFT",
      );
    }
    if (configSourceBindingsMatch(fromRevision.sourceObservation, source.observation)) {
      throw new ControlPlaneError(
        "latest Config revision은 이미 현재 discovery source에 결합되어 있습니다.",
        409,
        "CONFIG_SOURCE_ALREADY_CURRENT",
      );
    }

    const revision = await createDraftRevisionInTransaction(tx, {
      appId: source.app.id,
      payload: fromRevision.payload,
      payloadHash: fromRevision.payloadHash,
      createdBy: input.actor,
      idempotencyKey: input.idempotencyKey,
      sourceObservationId: source.observation.id,
      backfillContractVersion: CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION,
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.config.source-rebased",
        entityType: "ConfigRevision",
        entityId: revision.id,
        payload: {
          appId: source.app.id,
          repoId: input.repoId.toString(),
          fromRevisionId: fromRevision.id,
          fromRevision: fromRevision.revision,
          fromStatus: fromRevision.status,
          revision: revision.revision,
          expectedLatestRevision: input.expectedLatestRevision,
          payloadHash: revision.payloadHash,
          sourceObservationId: source.observation.id,
          sourceSha: source.observation.sourceSha,
          observationPayloadHash: source.observation.payloadHash,
          contractVersion: CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION,
          payloadChanged: false,
          activationAttempted: false,
        },
      },
    });
    return { revision, sourceObservation: source.observation, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * ConfigRevision이 전혀 없거나 검토 불가 legacy DRAFT만 있는 앱에 exact discovery
 * BuildTarget만 새 DRAFT로 투영한다. 기존 legacy payload는 입력으로 쓰지 않는다.
 */
export async function createDiscoveryProjectedConfigRevision(input: {
  repoId: bigint;
  expectedLatestRevision: number;
  mode: "DRAFT_ONLY";
  actor: string;
  idempotencyKey: string;
}) {
  const replay = await configRevisionReplayForKey(prisma, input.idempotencyKey);
  if (replay) {
    assertConfigRevisionReplay({
      stored: replay,
      repoId: input.repoId,
      actor: input.actor,
      expectedLatestRevision: input.expectedLatestRevision,
      contractVersion: CONFIG_REVISION_DISCOVERY_PROJECTION_CONTRACT_VERSION,
    });
    return { revision: replay, sourceObservation: replay.sourceObservation!, duplicate: true };
  }

  return runConfigRevisionMutation({
    repoId: input.repoId,
    actor: input.actor,
    expectedLatestRevision: input.expectedLatestRevision,
    idempotencyKey: input.idempotencyKey,
    contractVersion: CONFIG_REVISION_DISCOVERY_PROJECTION_CONTRACT_VERSION,
  }, () => prisma.$transaction(async (tx) => {
    const source = await lockedCurrentConfigSource(tx, input.repoId, { managedProductLifecycle: true });
    const afterLockReplay = await configRevisionReplayForKey(tx, input.idempotencyKey);
    if (afterLockReplay) {
      assertConfigRevisionReplay({
        stored: afterLockReplay,
        repoId: input.repoId,
        actor: input.actor,
        expectedLatestRevision: input.expectedLatestRevision,
        contractVersion: CONFIG_REVISION_DISCOVERY_PROJECTION_CONTRACT_VERSION,
      });
      return {
        revision: afterLockReplay,
        sourceObservation: afterLockReplay.sourceObservation!,
        duplicate: true,
      };
    }
    const actualLatestRevision = await latestConfigRevisionNumber(tx, source.app.id);
    assertExpectedLatestConfigRevision({
      expectedLatestRevision: input.expectedLatestRevision,
      actualLatestRevision,
    });
    const fromRevision = await tx.configRevision.findUnique({
      where: {
        appId_revision: {
          appId: source.app.id,
          revision: actualLatestRevision,
        },
      },
      include: {
        legacyConfigImport: {
          include: {
            parityObservations: {
              orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
              take: 1,
              select: { id: true, status: true, contractVersion: true },
            },
          },
        },
      },
    });
    const legacyImportCount = await tx.legacyConfigImport.count({
      where: { appId: source.app.id },
    });
    const projectionSource = resolveDiscoveryProjectionSource({
      appStatus: source.app.status,
      actualLatestRevision,
      legacyImportCount,
      fromRevision: fromRevision
        ? {
            revisionId: fromRevision.id,
            status: fromRevision.status,
            idempotencyKey: fromRevision.idempotencyKey,
            legacyConfigImport: fromRevision.legacyConfigImport,
          }
        : null,
    });
    const buildTargets = await tx.buildTarget.findMany({
      where: { appId: source.app.id },
      orderBy: { targetKey: "asc" },
      select: { market: true, observedSha: true },
    });
    const payload = projectDiscoveryConfigPayload({
      sourceSha: source.observation.sourceSha,
      buildTargets,
    });
    if (!payload) {
      throw new ControlPlaneError(
        "latest exact-SHA BuildTarget에 투영 가능한 market이 없습니다.",
        409,
        "BUILD_TARGET_MISSING",
      );
    }
    const payloadHash = jsonDigest(payload as JsonValue);
    const revision = await createDraftRevisionInTransaction(tx, {
      appId: source.app.id,
      payload,
      payloadHash,
      createdBy: input.actor,
      idempotencyKey: input.idempotencyKey,
      sourceObservationId: source.observation.id,
      backfillContractVersion: CONFIG_REVISION_DISCOVERY_PROJECTION_CONTRACT_VERSION,
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.config.discovery-projected",
        entityType: "ConfigRevision",
        entityId: revision.id,
        payload: {
          appId: source.app.id,
          repoId: input.repoId.toString(),
          appStatus: source.app.status,
          projectionSource: projectionSource.kind,
          ...(projectionSource.kind === "LEGACY_IMPORT"
            ? {
                fromRevisionId: projectionSource.revision.revisionId,
                fromRevision: actualLatestRevision,
                legacyImportId: projectionSource.legacyImport.id,
                legacyImportStatus: projectionSource.legacyImport.status,
                legacyParityObservationId: projectionSource.parity.id,
                legacyParityStatus: projectionSource.parity.status,
                legacyTransformVersion: projectionSource.legacyImport.transformVersion,
              }
            : {
                fromRevisionId: null,
                fromRevision: null,
                legacyImportCount,
              }),
          revision: revision.revision,
          expectedLatestRevision: input.expectedLatestRevision,
          payloadHash,
          sourceObservationId: source.observation.id,
          sourceSha: source.observation.sourceSha,
          observationPayloadHash: source.observation.payloadHash,
          contractVersion: CONFIG_REVISION_DISCOVERY_PROJECTION_CONTRACT_VERSION,
          excludedUnobservedFields: [
            "projectBlueprint",
            "localizations",
            "complianceDrafts",
            "assets",
            "support",
            "build",
          ],
          legacyPayloadCopied: false,
          mode: input.mode,
          activationAttempted: false,
        },
      },
    });
    return { revision, sourceObservation: source.observation, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

type ConfigRevisionActivationInput = {
  repoId: bigint;
  revision: number;
  expectedActiveRevision: number;
  actor: string;
  idempotencyKey: string;
  signingKey: string;
};

async function activateConfigRevisionInTransaction(
  tx: Prisma.TransactionClient,
  input: ConfigRevisionActivationInput,
) {
  const app = await appForRepoId(tx, input.repoId);
  await tx.$queryRaw`SELECT id FROM app WHERE id = ${app.id} FOR UPDATE`;
  const active = await tx.configRevision.findFirst({
    where: { appId: app.id, status: "ACTIVE" },
    orderBy: { revision: "desc" },
  });
  const target = await tx.configRevision.findUnique({
    where: { appId_revision: { appId: app.id, revision: input.revision } },
    include: { legacyConfigImport: { select: { id: true } } },
  });
  if (!target) throw new ControlPlaneError("Config revision을 찾을 수 없습니다.", 404, "REVISION_NOT_FOUND");
  // 새 validator 도입 전에 생성된 DRAFT도 activation 시 다시 검사해 우회를 막는다.
  assertConfigRevisionPayload(target.payload);
  if (jsonDigest(target.payload as JsonValue) !== target.payloadHash) {
    throw new ControlPlaneError(
      "Config revision payload가 저장 digest와 일치하지 않습니다.",
      409,
      "CONFIG_REVISION_PAYLOAD_DRIFT",
    );
  }
  assertActivationPreconditions({
    actualActiveRevision: active?.revision ?? 0,
    expectedActiveRevision: input.expectedActiveRevision,
    targetStatus: target.status,
    // append-only import relation이 운영자 DB 조작으로 훼손돼도 파생 DRAFT key가
    // 남아 있는 한 activation을 fail-closed한다.
    shadowImportId: target.legacyConfigImport?.id
      ?? (target.idempotencyKey.startsWith("legacy-shadow-draft:") ? target.idempotencyKey : null),
  });

  const activatedAt = new Date();
  const snapshot = {
    schemaVersion: 1,
    appId: app.id,
    repoId: app.repoId?.toString() ?? null,
    repoFullName: app.repoFullName,
    revision: target.revision,
    payloadHash: target.payloadHash,
    payload: target.payload,
    activatedAt: activatedAt.toISOString(),
  } as JsonValue;
  const signed = signSnapshot(snapshot, input.signingKey);
  let supersededLegacyDraftCount = 0;

  if (active) {
    const superseded = await tx.configRevision.updateMany({
      where: {
        id: active.id,
        status: "ACTIVE",
        activeSlot: app.id,
      },
      data: {
        status: "SUPERSEDED",
        activeSlot: null,
        supersededAt: activatedAt,
      },
    });
    if (superseded.count !== 1) {
      throw new ControlPlaneError("ACTIVE Config revision CAS에 실패했습니다.", 409, "REVISION_CONFLICT");
    }
  }
  if (target.idempotencyKey.startsWith("ui-compliance-batch-create:")) {
    const supersededLegacyDrafts = await tx.configRevision.updateMany({
      where: {
        appId: app.id,
        status: "DRAFT",
        idempotencyKey: { startsWith: "legacy-shadow-draft:" },
      },
      data: {
        status: "SUPERSEDED",
        supersededAt: activatedAt,
      },
    });
    supersededLegacyDraftCount = supersededLegacyDrafts.count;
  }
  const updated = await tx.configRevision.updateMany({
    where: { id: target.id, status: "DRAFT", activeSlot: null },
    data: {
      status: "ACTIVE",
      activeSlot: app.id,
      activationIdempotencyKey: input.idempotencyKey,
      activatedSnapshot: jsonInput(snapshot),
      snapshotDigest: signed.digest,
      snapshotSignature: signed.signature,
      activatedAt,
    },
  });
  if (updated.count !== 1) {
    throw new ControlPlaneError("Config revision activation CAS에 실패했습니다.", 409, "REVISION_CONFLICT");
  }
  const revision = await tx.configRevision.findUniqueOrThrow({ where: { id: target.id } });
  await tx.auditLog.create({
    data: {
      actorLogin: input.actor,
      action: "control-plane.config.activate",
      entityType: "ConfigRevision",
      entityId: revision.id,
      payload: {
        appId: app.id,
        revision: revision.revision,
        previousRevision: active?.revision ?? null,
        snapshotDigest: signed.digest,
        supersededLegacyDraftCount,
      },
    },
  });
  return revision;
}

export async function activateConfigRevision(input: ConfigRevisionActivationInput) {
  const replay = await prisma.configRevision.findUnique({
    where: { activationIdempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    if (replay.revision !== input.revision || replay.app.repoId !== input.repoId) {
      throw new ControlPlaneError(
        "같은 idempotency key가 다른 revision activation에 사용되었습니다.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    return { revision: replay, duplicate: true };
  }

  return prisma.$transaction(async (tx) => {
    const revision = await activateConfigRevisionInTransaction(tx, input);
    return { revision, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export type ConfigSourceAutoRebaseResult =
  | {
      outcome: "ALREADY_CURRENT";
      revision: ConfigRevision;
      sourceObservation: ConfigSourceObservation;
      duplicate: boolean;
    }
  | {
      outcome: "SOURCE_REBASED_AND_ACTIVATED";
      revision: ConfigRevision;
      sourceObservation: ConfigSourceObservation;
      previousRevision: number;
      duplicate: boolean;
    }
  | {
      outcome: "NEEDS_INPUT";
      reason: ConfigSourceAutoRebaseNeedsInputReason;
      sourceObservation: ConfigSourceObservation;
      revision: ConfigRevision | null;
      duplicate: false;
    };

/**
 * Hourly desired-state scheduler 전용 source-only activation이다. caller는 SHA나
 * revision을 고르지 못하고, registration/app lock 아래 current discovery와 ACTIVE
 * snapshot을 다시 읽는다. payload 또는 current BuildTarget market이 달라지면
 * 기존 DRAFT를 보존한 채 NEEDS_INPUT으로 끝낸다.
 */
export async function autoRebaseCurrentActiveConfigSource(input: {
  repoId: bigint;
  actor: string;
  signingKey: string;
}): Promise<ConfigSourceAutoRebaseResult> {
  return prisma.$transaction(async (tx) => {
    const source = await lockedCurrentConfigSource(tx, input.repoId, { managedProductLifecycle: true });
    const activeRevisions = await tx.configRevision.findMany({
      where: { appId: source.app.id, status: "ACTIVE" },
      orderBy: { revision: "desc" },
      take: 2,
      include: {
        sourceObservation: {
          select: {
            id: true,
            appId: true,
            sourceSha: true,
            sourceRef: true,
            payload: true,
            payloadHash: true,
            requestHash: true,
          },
        },
      },
    });
    if (activeRevisions.length !== 1) {
      return {
        outcome: "NEEDS_INPUT",
        reason: "ACTIVE_CONFIG_MISSING",
        sourceObservation: source.observation,
        revision: activeRevisions[0] ?? null,
        duplicate: false,
      };
    }
    const active = activeRevisions[0]!;
    let activePayload: Record<string, unknown>;
    try {
      activePayload = configPayloadFromSignedSnapshot({
        revision: active,
        signingKey: input.signingKey,
        appId: source.app.id,
        repoId: input.repoId.toString(),
        repoFullName: source.app.repoFullName,
      });
      const snapshot = jsonRecord(active.activatedSnapshot);
      if (
        active.activeSlot !== source.app.id
        || !active.activatedAt
        || snapshot?.activatedAt !== active.activatedAt.toISOString()
      ) throw new Error("ACTIVE_SNAPSHOT_TIME_MISMATCH");
    } catch {
      return {
        outcome: "NEEDS_INPUT",
        reason: "ACTIVE_SNAPSHOT_INVALID",
        sourceObservation: source.observation,
        revision: active,
        duplicate: false,
      };
    }

    if (configSourceBindingsMatch(active.sourceObservation, source.observation)) {
      return {
        outcome: "ALREADY_CURRENT",
        revision: active,
        sourceObservation: source.observation,
        duplicate: false,
      };
    }

    const latest = await tx.configRevision.findFirst({
      where: { appId: source.app.id },
      orderBy: { revision: "desc" },
      include: {
        legacyConfigImport: { select: { id: true } },
        sourceObservation: {
          select: {
            id: true,
            appId: true,
            sourceSha: true,
            sourceRef: true,
            payload: true,
            payloadHash: true,
            requestHash: true,
          },
        },
      },
    });
    if (!latest) {
      return {
        outcome: "NEEDS_INPUT",
        reason: "ACTIVE_CONFIG_MISSING",
        sourceObservation: source.observation,
        revision: active,
        duplicate: false,
      };
    }
    if (
      latest.status === "DRAFT"
      && (
        latest.legacyConfigImport
        || latest.idempotencyKey.startsWith("legacy-shadow-draft:")
      )
    ) {
      return {
        outcome: "NEEDS_INPUT",
        reason: "LEGACY_DRAFT_REQUIRES_INPUT",
        sourceObservation: source.observation,
        revision: latest,
        duplicate: false,
      };
    }

    let desiredPayload: Record<string, unknown>;
    try {
      assertConfigRevisionPayload(latest.payload);
      if (jsonDigest(latest.payload as JsonValue) !== latest.payloadHash) {
        throw new Error("CONFIG_REVISION_PAYLOAD_DRIFT");
      }
      desiredPayload = latest.payload;
    } catch {
      return {
        outcome: "NEEDS_INPUT",
        reason: "DESIRED_PAYLOAD_CHANGED",
        sourceObservation: source.observation,
        revision: latest,
        duplicate: false,
      };
    }
    const buildTargets = await tx.buildTarget.findMany({
      where: { appId: source.app.id },
      orderBy: { targetKey: "asc" },
      select: { market: true, observedSha: true },
    });
    const safetyReason = assessConfigSourceAutoRebaseSafety({
      sourceSha: source.observation.sourceSha,
      activePayload,
      desiredPayload,
      buildTargets,
    });
    if (safetyReason) {
      return {
        outcome: "NEEDS_INPUT",
        reason: safetyReason,
        sourceObservation: source.observation,
        revision: latest,
        duplicate: false,
      };
    }

    const idempotencyBase = `config-source-auto-rebase:${source.app.id}:${source.observation.id}`;
    const activationIdempotencyKey = `${idempotencyBase}:activate`;
    const replay = await tx.configRevision.findUnique({
      where: { activationIdempotencyKey },
    });
    if (replay) {
      if (
        replay.appId !== source.app.id
        || replay.sourceObservationId !== source.observation.id
        || replay.payloadHash !== active.payloadHash
      ) {
        throw new ControlPlaneError(
          "같은 자동 source rebase key가 다른 revision에 사용되었습니다.",
          409,
          "IDEMPOTENCY_CONFLICT",
        );
      }
      return {
        outcome: "SOURCE_REBASED_AND_ACTIVATED",
        revision: replay,
        sourceObservation: source.observation,
        previousRevision: active.revision,
        duplicate: true,
      };
    }

    let target: ConfigRevision | null = latest.status === "DRAFT"
      && configSourceBindingsMatch(latest.sourceObservation, source.observation)
      ? latest
      : null;
    if (!target) {
      const existing = await tx.configRevision.findFirst({
        where: {
          appId: source.app.id,
          sourceObservationId: source.observation.id,
          backfillContractVersion: CONFIG_REVISION_SOURCE_AUTO_REBASE_CONTRACT_VERSION,
        },
      });
      if (existing) {
        if (
          existing.status !== "DRAFT"
          || existing.payloadHash !== active.payloadHash
          || jsonDigest(existing.payload as JsonValue) !== active.payloadHash
        ) {
          throw new ControlPlaneError(
            "기존 자동 source rebase revision identity가 일치하지 않습니다.",
            409,
            "IDEMPOTENCY_CONFLICT",
          );
        }
        target = existing;
      } else {
        target = await createDraftRevisionInTransaction(tx, {
          appId: source.app.id,
          payload: activePayload,
          payloadHash: active.payloadHash,
          createdBy: input.actor,
          idempotencyKey: `${idempotencyBase}:draft`,
          sourceObservationId: source.observation.id,
          backfillContractVersion: CONFIG_REVISION_SOURCE_AUTO_REBASE_CONTRACT_VERSION,
        });
        await tx.auditLog.create({
          data: {
            actorLogin: input.actor,
            action: "control-plane.config.source-rebased",
            entityType: "ConfigRevision",
            entityId: target.id,
            payload: {
              appId: source.app.id,
              repoId: input.repoId.toString(),
              fromRevisionId: active.id,
              fromRevision: active.revision,
              fromStatus: active.status,
              revision: target.revision,
              payloadHash: target.payloadHash,
              sourceObservationId: source.observation.id,
              sourceSha: source.observation.sourceSha,
              observationPayloadHash: source.observation.payloadHash,
              contractVersion: CONFIG_REVISION_SOURCE_AUTO_REBASE_CONTRACT_VERSION,
              payloadChanged: false,
              activationAttempted: true,
            },
          },
        });
      }
    }
    if (!target) {
      throw new ControlPlaneError(
        "자동 source rebase target을 확정할 수 없습니다.",
        409,
        "REVISION_CONFLICT",
      );
    }

    const revision = await activateConfigRevisionInTransaction(tx, {
      repoId: input.repoId,
      revision: target.revision,
      expectedActiveRevision: active.revision,
      actor: input.actor,
      idempotencyKey: activationIdempotencyKey,
      signingKey: input.signingKey,
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.config.source-auto-activated",
        entityType: "ConfigRevision",
        entityId: revision.id,
        payload: {
          appId: source.app.id,
          repoId: input.repoId.toString(),
          previousRevisionId: active.id,
          previousRevision: active.revision,
          revision: revision.revision,
          sourceObservationId: source.observation.id,
          sourceSha: source.observation.sourceSha,
          payloadHash: revision.payloadHash,
          contractVersion: CONFIG_REVISION_SOURCE_AUTO_REBASE_CONTRACT_VERSION,
          payloadChanged: false,
          legalOrComplianceChanged: false,
          paymentChanged: false,
          reviewOrPublicApprovalChanged: false,
          providerMutationAttempted: false,
        },
      },
    });
    return {
      outcome: "SOURCE_REBASED_AND_ACTIVATED",
      revision,
      sourceObservation: source.observation,
      previousRevision: active.revision,
      duplicate: false,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function recordReauthRequest(input: {
  repoId: bigint;
  runId?: string;
  provider: string;
  origin: string;
  publicAccountId: string;
  capability: string;
  gate: ReauthGate;
  actor: string;
  idempotencyKey: string;
}) {
  const provider = input.provider.toLowerCase();
  const origin = new URL(input.origin).origin;
  const replay = await prisma.reauthRequest.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    if (
      replay.app.repoId !== input.repoId
      || replay.runId !== (input.runId ?? null)
      || replay.provider !== provider
      || replay.origin !== origin
      || replay.publicAccountId !== input.publicAccountId
      || replay.capability !== input.capability
      || replay.gate !== input.gate
      || replay.requestedBy !== input.actor
    ) {
      throw new ControlPlaneError(
        "idempotency key가 다른 reauth 요청에 사용되었습니다.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    return { request: replay, duplicate: true };
  }

  return prisma.$transaction(async (tx) => {
    const app = await appForRepoId(tx, input.repoId);
    if (input.runId) {
      const run = await tx.agentRun.findUnique({
        where: { id: input.runId },
        select: { appId: true, repoFullName: true },
      });
      if (!run || (run.appId !== app.id && run.repoFullName.toLowerCase() !== app.repoFullName.toLowerCase())) {
        throw new ControlPlaneError("reauth run이 앱 범위와 일치하지 않습니다.", 409, "RUN_SCOPE_MISMATCH");
      }
    }
    const request = await tx.reauthRequest.create({
      data: {
        appId: app.id,
        runId: input.runId,
        provider,
        origin,
        publicAccountId: input.publicAccountId,
        capability: input.capability,
        gate: input.gate,
        requestedBy: input.actor,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.reauth.request",
        entityType: "ReauthRequest",
        entityId: request.id,
        payload: {
          appId: app.id,
          runId: input.runId ?? null,
          provider,
          origin,
          publicAccountId: input.publicAccountId,
          capability: input.capability,
          gate: input.gate,
        },
      },
    });
    return { request, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function listReauthRequests(repoId: bigint) {
  const app = await appForRepoId(prisma, repoId);
  return prisma.reauthRequest.findMany({
    where: { appId: app.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      runId: true,
      provider: true,
      origin: true,
      publicAccountId: true,
      capability: true,
      gate: true,
      status: true,
      generation: true,
      requestedBy: true,
      trustedLocalRequestedBy: true,
      trustedLocalRequestedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/** Backoffice의 DB session/RBAC를 통과한 사람 UI server action에서만 호출한다. */
export async function markReauthTrustedLocalPendingFromHumanUi(input: {
  repoId: bigint;
  reauthRequestId: string;
  expectedGeneration: number;
  actor: string;
  idempotencyKey: string;
}) {
  const replay = await prisma.reauthRequest.findUnique({
    where: { trustedLocalIdempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    if (
      replay.id !== input.reauthRequestId
      || replay.app.repoId !== input.repoId
      || replay.trustedLocalRequestedBy !== input.actor
    ) {
      throw new ControlPlaneError(
        "idempotency key가 다른 trusted-local 요청에 사용되었습니다.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    return { request: replay, duplicate: true };
  }

  return prisma.$transaction(async (tx) => {
    const app = await appForRepoId(tx, input.repoId);
    const requestedAt = new Date();
    const updated = await tx.reauthRequest.updateMany({
      where: {
        id: input.reauthRequestId,
        appId: app.id,
        status: "HUMAN_REAUTH_REQUIRED",
        generation: input.expectedGeneration,
        trustedLocalIdempotencyKey: null,
      },
      data: {
        status: "TRUSTED_LOCAL_PENDING",
        generation: { increment: 1 },
        trustedLocalIdempotencyKey: input.idempotencyKey,
        trustedLocalRequestedBy: input.actor,
        trustedLocalRequestedAt: requestedAt,
      },
    });
    if (updated.count !== 1) {
      throw new ControlPlaneError(
        "reauth 상태가 변경되었거나 이미 trusted-local 대기 중입니다.",
        409,
        "REAUTH_STATE_CONFLICT",
      );
    }
    const request = await tx.reauthRequest.findUniqueOrThrow({
      where: { id: input.reauthRequestId },
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.reauth.trusted-local-pending.human-ui",
        entityType: "ReauthRequest",
        entityId: request.id,
        payload: {
          appId: request.appId,
          generation: request.generation,
          provider: request.provider,
          publicAccountId: request.publicAccountId,
          transitionSource: "BACKOFFICE_HUMAN_UI",
        },
      },
    });
    return { request, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function resolveManifest(input: {
  repoId: bigint;
  sourceSha: string;
  market?: string;
  revision?: number;
  signingKey: string;
}) {
  const app = await appForRepoId(prisma, input.repoId);
  const revision = input.revision
    ? await prisma.configRevision.findUnique({
        where: { appId_revision: { appId: app.id, revision: input.revision } },
      })
    : await prisma.configRevision.findFirst({ where: { appId: app.id, status: "ACTIVE" } });
  if (!revision) {
    throw new ControlPlaneError("활성화된 Config revision이 없습니다.", 409, "NO_ACTIVE_CONFIG");
  }
  const configPayload = configPayloadFromSignedSnapshot({
    revision,
    signingKey: input.signingKey,
    appId: app.id,
    repoId: input.repoId.toString(),
    repoFullName: app.repoFullName,
  });
  const discovery = await prisma.discoveryObservation.findFirst({
    where: { appId: app.id, sourceSha: input.sourceSha.toLowerCase() },
    orderBy: latestDiscoveryObservationOrder(),
  });
  if (!discovery) {
    throw new ControlPlaneError("요청한 source SHA의 discovery observation이 없습니다.", 409, "NO_DISCOVERY_FOR_SHA");
  }
  const workflowCaller = resolvedWorkflowCaller({
    profile: discovery.workflowProfile,
    packageManager: discovery.workflowPackageManager,
    workingDirectory: discovery.workflowWorkingDirectory,
  });
  const requestedMarket = input.market?.toLowerCase();
  if (
    requestedMarket
    && !BUILD_TARGET_MARKETS.includes(requestedMarket as BuildTargetMarket)
  ) {
    throw new ControlPlaneError("지원하지 않는 market입니다.", 409, "MARKET_NOT_ENABLED");
  }
  const market = requestedMarket as BuildTargetMarket | undefined;
  const enabledMarkets = configPayload.markets
    .filter((profile) => profile.enabled)
    .map((profile) => profile.market);
  if (market && !enabledMarkets.includes(market)) {
    throw new ControlPlaneError("ACTIVE revision에서 활성화된 market이 아닙니다.", 409, "MARKET_NOT_ENABLED");
  }
  const [buildTargets, externalBindings, providerRows, platformFleet] = await Promise.all([
    prisma.buildTarget.findMany({
      where: {
        appId: app.id,
        observedSha: input.sourceSha.toLowerCase(),
        ...(market ? { OR: [{ market }, { market: null }] } : {}),
      },
      orderBy: { targetKey: "asc" },
    }),
    prisma.externalBinding.findMany({
      where: { appId: app.id, ...(market ? { provider: market } : {}) },
      orderBy: [{ provider: "asc" }, { bindingType: "asc" }],
    }),
    prisma.providerObservation.findMany({
      where: { appId: app.id, ...(market ? { provider: market } : {}) },
      orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.platformFleetBinding.findUnique({ where: { appId: app.id } }),
  ]);
  const latestProvider = new Map<string, (typeof providerRows)[number]>();
  for (const row of providerRows) {
    const key = `${row.provider}:${row.resourceType}:${row.resourceId}`;
    if (!latestProvider.has(key)) latestProvider.set(key, row);
  }
  for (const requiredMarket of market ? [market] : enabledMarkets) {
    const identity = exactBuildTargetIdentity(buildTargets, requiredMarket, externalBindings);
    if (identity.status === "TARGET_MISSING" || identity.status === "TARGET_AMBIGUOUS") {
      throw new ControlPlaneError(
        "요청한 source SHA와 market에 고정된 BuildTarget이 하나 필요합니다.",
        409,
        "BUILD_TARGET_MISMATCH",
      );
    }
    if (identity.status !== "READY") {
      const code = identity.status === "EXTERNAL_BINDING_AMBIGUOUS"
        ? "BUILD_IDENTITY_AMBIGUOUS"
        : identity.status === "IDENTITY_CONFLICT"
          ? "BUILD_IDENTITY_CONFLICT"
          : "BUILD_IDENTITY_MISSING";
      throw new ControlPlaneError(
        "요청한 source SHA와 provider application binding의 공개 build identity를 확정할 수 없습니다.",
        409,
        code,
      );
    }
  }
  return {
    schemaVersion: 1,
    resolvedAt: new Date().toISOString(),
    app: { ...app, repoId: app.repoId?.toString() ?? null },
    source: {
      sha: input.sourceSha.toLowerCase(),
      ref: discovery.sourceRef,
      observationId: discovery.id,
      payload: discovery.payload,
    },
    workflowCaller,
    config: {
      id: revision.id,
      revision: revision.revision,
      status: revision.status,
      snapshot: revision.activatedSnapshot,
      digest: revision.snapshotDigest,
      signature: revision.snapshotSignature,
    },
    ...(configPayload.build?.workflowBundleSha && configPayload.build.workflowBundleDigest
      ? {
          workflowBundleBinding: {
            sourceSha: configPayload.build.workflowBundleSha.toLowerCase(),
            payloadDigest: configPayload.build.workflowBundleDigest.toLowerCase(),
          },
        }
      : {}),
    market: market ?? null,
    buildTargets,
    externalBindings,
    providerObservations: [...latestProvider.values()],
    platformFleet,
  };
}

export async function resolveStaticRuntimeManifest(input: {
  identity: GitHubActionsStaticManifestIdentity;
  signingKey: string;
  snapshotSignatureKeyId: string;
  snapshotSignaturePolicyRevision: string;
  now?: Date;
}, client: Pick<
  typeof prisma,
  "app" | "configRevision" | "discoveryObservation" | "repositoryRegistration"
> = prisma) {
  const repositoryId = BigInt(input.identity.repositoryId);
  const app = await client.app.findUnique({
    where: { repoId: repositoryId },
    select: {
      id: true,
      repoId: true,
      repoFullName: true,
      status: true,
      isPublicRepo: true,
    },
  });
  if (!app) throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  if (
    app.repoId !== repositoryId
    || app.repoFullName !== input.identity.fullName
  ) {
    throw new ControlPlaneError(
      "GitHub OIDC repository identity가 중앙 App binding과 일치하지 않습니다.",
      403,
      "REPOSITORY_IDENTITY_MISMATCH",
    );
  }
  const registration = await client.repositoryRegistration.findUnique({
    where: { repoId: repositoryId },
    select: { defaultBranch: true, archived: true },
  });
  const expectedSourceRef = repositoryDefaultBranchRef(registration?.defaultBranch ?? null);
  if (
    registration?.archived
    || registration?.defaultBranch !== input.identity.defaultBranch
    || !expectedSourceRef
  ) {
    throw new ControlPlaneError(
      "runtime 요청과 현재 repository default branch binding이 일치하지 않습니다.",
      409,
      "REPOSITORY_DEFAULT_BRANCH_MISMATCH",
    );
  }
  const expectedVisibility = app.isPublicRepo ? "public" : "private";
  const expectedRunner = app.isPublicRepo ? "github-hosted" : "self-hosted";
  if (
    input.identity.repositoryVisibility !== expectedVisibility
    || input.identity.runnerEnvironment !== expectedRunner
  ) {
    throw new ControlPlaneError(
      "repository visibility 또는 runner trust boundary가 중앙 binding과 일치하지 않습니다.",
      403,
      "RUNNER_TRUST_BOUNDARY_MISMATCH",
    );
  }

  const revision = await client.configRevision.findFirst({
    where: { appId: app.id, status: "ACTIVE" },
  });
  if (!revision) {
    throw new ControlPlaneError("활성화된 Config revision이 없습니다.", 409, "NO_ACTIVE_CONFIG");
  }
  const configPayload = configPayloadFromSignedSnapshot({
    revision,
    signingKey: input.signingKey,
    appId: app.id,
    repoId: input.identity.repositoryId,
    repoFullName: app.repoFullName,
  });
  if (
    !configPayload.build?.workflowBundleSha
    || configPayload.build.workflowBundleSha.toLowerCase() !== input.identity.workflowBundleSha
  ) {
    throw new ControlPlaneError(
      "ACTIVE revision이 요청한 WorkflowBundle SHA를 승인하지 않았습니다.",
      409,
      "WORKFLOW_BUNDLE_NOT_APPROVED",
    );
  }
  // STATIC_CHECK 예외는 ACTIVE 설정·discovery가 결합된 기본 브랜치 exact source
  // (bindingSourceSha)에 묶인다. main 실행은 application source와 같고, 후보 PR 실행은
  // merge 커밋이 아니라 PR base다. lockfile digest 결합은 중앙 staging이 별도로 강제한다.
  const dependencyAuditException = resolveDependencyAuditException({
    exception: configPayload.build.dependencyAuditException,
    actionClass: "STATIC_CHECK",
    repositoryId: input.identity.repositoryId,
    fullName: app.repoFullName,
    applicationSourceSha: input.identity.bindingSourceSha,
    now: input.now ?? new Date(),
  });

  const discovery = await client.discoveryObservation.findFirst({
    where: {
      appId: app.id,
      sourceSha: input.identity.bindingSourceSha,
    },
    orderBy: latestDiscoveryObservationOrder(),
  });
  if (!discovery) {
    throw new ControlPlaneError(
      "binding source SHA의 discovery observation이 없습니다.",
      409,
      "NO_DISCOVERY_FOR_SHA",
    );
  }
  if (discovery.sourceRef !== expectedSourceRef || !discovery.requestHash) {
    throw new ControlPlaneError(
      "default branch exact-SHA discovery provenance를 검증할 수 없습니다.",
      409,
      "DISCOVERY_PROVENANCE_INVALID",
    );
  }
  const workflowCaller = resolvedWorkflowCaller({
    profile: discovery.workflowProfile,
    packageManager: discovery.workflowPackageManager,
    workingDirectory: discovery.workflowWorkingDirectory,
  });
  const expectedCalledWorkflowPath: GitHubActionsStaticWorkflowPath =
    workflowCaller.profile === "godot"
      ? GITHUB_ACTIONS_STATIC_WORKFLOW_PATHS.godot
      : GITHUB_ACTIONS_STATIC_WORKFLOW_PATHS.javascript;
  if (input.identity.calledWorkflowPath !== expectedCalledWorkflowPath) {
    throw new ControlPlaneError(
      "호출된 중앙 workflow와 exact-SHA discovery profile이 일치하지 않습니다.",
      409,
      "STATIC_WORKFLOW_PROFILE_MISMATCH",
    );
  }
  const workflowDirectories = {
    workspaceRoot: observedStaticWorkspaceRoot({
      payload: discovery.payload,
      caller: workflowCaller,
      repositoryId: input.identity.repositoryId,
      fullName: app.repoFullName,
      sourceSha: input.identity.bindingSourceSha,
      sourceRef: expectedSourceRef,
    }),
    commandDirectory: workflowCaller.workingDirectory,
  };
  const staticBinding: StaticRuntimeBinding = workflowCaller.profile === "godot"
    ? {
        ...workflowDirectories,
        profile: workflowCaller.profile,
        packageManager: workflowCaller.packageManager,
      }
    : {
        ...workflowDirectories,
        profile: workflowCaller.profile,
        packageManager: workflowCaller.packageManager,
      };
  if (!revision.snapshotDigest || !revision.snapshotSignature) {
    throw new ControlPlaneError(
      "Config snapshot 서명 provenance를 확인할 수 없습니다.",
      409,
      "INVALID_CONFIG_SIGNATURE",
    );
  }
  try {
    return buildStaticRuntimeManifestReadback({
      lifecycleState: app.status,
      repositoryId: input.identity.repositoryId,
      fullName: app.repoFullName,
      bindingSourceSha: input.identity.bindingSourceSha,
      sourceRef: expectedSourceRef,
      applicationSourceSha: input.identity.applicationSourceSha,
      observationId: discovery.id,
      observationRequestHash: discovery.requestHash,
      configRevisionId: revision.id,
      configRevision: revision.revision,
      configRevisionPayloadHash: revision.payloadHash,
      signedSnapshotDigest: revision.snapshotDigest,
      snapshotSignature: revision.snapshotSignature,
      snapshotSignatureKeyId: input.snapshotSignatureKeyId,
      snapshotSignaturePolicyRevision: input.snapshotSignaturePolicyRevision,
      staticBinding,
      dependencyAuditException,
    });
  } catch (error) {
    if (error instanceof StaticRuntimeManifestError) {
      throw new ControlPlaneError(
        "서명된 runtime manifest provenance를 생성할 수 없습니다.",
        error.code === "SNAPSHOT_SIGNATURE_IDENTITY_MISSING" ? 503 : 409,
        error.code,
      );
    }
    throw error;
  }
}

export async function resolveBuildRuntimeManifest(input: {
  identity: GitHubActionsBuildManifestIdentity;
  signingKey: string;
  snapshotSignatureKeyId: string;
  snapshotSignaturePolicyRevision: string;
  now?: Date;
}, client: Pick<
  typeof prisma,
  "app" | "configRevision" | "discoveryObservation" | "workflowBundleRegistryRecord" | "repositoryRegistration"
> = prisma) {
  const repositoryId = BigInt(input.identity.repositoryId);
  const app = await client.app.findUnique({
    where: { repoId: repositoryId },
    select: {
      id: true,
      repoId: true,
      repoFullName: true,
      status: true,
      isPublicRepo: true,
    },
  });
  if (!app) throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  if (app.repoId !== repositoryId || app.repoFullName !== input.identity.fullName) {
    throw new ControlPlaneError(
      "GitHub OIDC repository identity가 중앙 App binding과 일치하지 않습니다.",
      403,
      "REPOSITORY_IDENTITY_MISMATCH",
    );
  }
  const registration = await client.repositoryRegistration.findUnique({
    where: { repoId: repositoryId },
    select: { defaultBranch: true, archived: true },
  });
  const defaultBranchSourceRef = repositoryDefaultBranchRef(registration?.defaultBranch ?? null);
  const expectedSourceRef = input.identity.mode === "RELEASE"
    ? input.identity.releaseRef
    : defaultBranchSourceRef;
  if (
    registration?.archived
    || registration?.defaultBranch !== input.identity.defaultBranch
    || !defaultBranchSourceRef
    || !expectedSourceRef
  ) {
    throw new ControlPlaneError(
      "build 요청과 현재 repository default branch binding이 일치하지 않습니다.",
      409,
      "REPOSITORY_DEFAULT_BRANCH_MISMATCH",
    );
  }
  if (app.isPublicRepo || input.identity.repositoryVisibility !== "private"
    || input.identity.runnerEnvironment !== "self-hosted") {
    throw new ControlPlaneError(
      "Android build-only runtime은 private repository의 trusted self-hosted 경계만 허용합니다.",
      403,
      "RUNNER_TRUST_BOUNDARY_MISMATCH",
    );
  }
  if (app.status !== "ACTIVE") {
    throw new ControlPlaneError(
      "ACTIVE 앱만 build-only runtime을 사용할 수 있습니다.",
      403,
      `${app.status}_BUILD_RUNTIME_FORBIDDEN`,
    );
  }

  const revision = await client.configRevision.findFirst({
    where: { appId: app.id, status: "ACTIVE" },
  });
  if (!revision) {
    throw new ControlPlaneError("활성화된 Config revision이 없습니다.", 409, "NO_ACTIVE_CONFIG");
  }
  const configPayload = configPayloadFromSignedSnapshot({
    revision,
    signingKey: input.signingKey,
    appId: app.id,
    repoId: input.identity.repositoryId,
    repoFullName: app.repoFullName,
  });
  if (
    configPayload.build?.workflowBundleSha?.toLowerCase() !== input.identity.workflowBundleSha
    || !configPayload.build.workflowBundleDigest
  ) {
    throw new ControlPlaneError(
      "ACTIVE revision이 WorkflowBundle source SHA와 payload digest를 함께 승인하지 않았습니다.",
      409,
      "WORKFLOW_BUNDLE_BINDING_MISSING",
    );
  }
  const workflowBundlePayloadDigest = configPayload.build.workflowBundleDigest.toLowerCase();
  const workflowBundleApprovalState = input.identity.mode === "RELEASE"
    ? "APPROVED"
    : input.identity.mode;
  const dependencyAuditException = resolveDependencyAuditException({
    exception: configPayload.build.dependencyAuditException,
    actionClass: "ANDROID_BUILD_ONLY",
    repositoryId: input.identity.repositoryId,
    fullName: app.repoFullName,
    applicationSourceSha: input.identity.applicationSourceSha,
    now: input.now ?? new Date(),
  });
  const registry = await client.workflowBundleRegistryRecord.findFirst({
    where: {
      registryId: "seorilabs-workflow-bundles-v5",
      subject: `workflow-bundle-v5:${input.identity.workflowBundleSha}`,
      sourceSha: input.identity.workflowBundleSha,
      workflowExecutionSha: input.identity.workflowBundleSha,
      payloadDigest: workflowBundlePayloadDigest,
      approvalState: workflowBundleApprovalState,
    },
  });
  if (
    !registry
    || registry.sourceSha !== input.identity.workflowBundleSha
    || registry.workflowExecutionSha !== input.identity.workflowBundleSha
    || registry.payloadDigest !== workflowBundlePayloadDigest
    || registry.approvalState !== workflowBundleApprovalState
  ) {
    throw new ControlPlaneError(
      "Config와 분리된 immutable WorkflowBundle registry readback이 없습니다.",
      409,
      "WORKFLOW_BUNDLE_REGISTRY_READBACK_MISSING",
    );
  }
  if (
    workflowBundleApprovalState === "CANDIDATE"
      ? !registry.artifactRunId || !registry.artifactId || !registry.artifactDigest
      : !registry.approvalPayloadDigest || !registry.approvalKeyId || !registry.approvalPolicyRevision
  ) {
    throw new ControlPlaneError(
      "WorkflowBundle registry provenance가 불완전합니다.",
      409,
      "WORKFLOW_BUNDLE_REGISTRY_PROVENANCE_INVALID",
    );
  }
  const { verifyWorkflowBundleRegistryReadback } = await import(
    "@/lib/control-plane/workflow-bundle-v5-registry"
  );
  verifyWorkflowBundleRegistryReadback(
    registry,
    process.env.WORKFLOW_BUNDLE_V5_APPROVAL_PUBLIC_KEYS_JSON ?? "",
  );

  const discovery = await client.discoveryObservation.findFirst({
    where: {
      appId: app.id,
      sourceSha: input.identity.applicationSourceSha,
    },
    orderBy: latestDiscoveryObservationOrder(),
  });
  if (!discovery) {
    throw new ControlPlaneError(
      "application source SHA의 discovery observation이 없습니다.",
      409,
      "NO_DISCOVERY_FOR_SHA",
    );
  }
  if (discovery.sourceRef !== defaultBranchSourceRef || !discovery.requestHash) {
    throw new ControlPlaneError(
      "default branch exact-SHA discovery provenance를 검증할 수 없습니다.",
      409,
      "DISCOVERY_PROVENANCE_INVALID",
    );
  }
  const bindingResult = androidBuildBindingObservationSchema.array().length(1).safeParse(
    discovery.buildBindings,
  );
  if (!bindingResult.success) {
    throw new ControlPlaneError(
      "exact-SHA discovery에 단일 Android build binding fact가 없습니다.",
      409,
      "BUILD_BINDING_OBSERVATION_MISSING",
    );
  }
  const buildBinding = bindingResult.data[0];
  if (buildBinding.buildProfile !== input.identity.buildProfile) {
    throw new ControlPlaneError(
      "호출된 중앙 build workflow와 discovery build profile이 일치하지 않습니다.",
      409,
      "BUILD_WORKFLOW_PROFILE_MISMATCH",
    );
  }
  if (!revision.snapshotDigest || !revision.snapshotSignature) {
    throw new ControlPlaneError(
      "Config snapshot 서명 provenance를 확인할 수 없습니다.",
      409,
      "INVALID_CONFIG_SIGNATURE",
    );
  }
  try {
    return buildRuntimeManifestReadback({
      mode: input.identity.mode,
      workflowBundleApprovalState,
      lifecycleState: app.status,
      repositoryId: input.identity.repositoryId,
      fullName: app.repoFullName,
      applicationSourceSha: input.identity.applicationSourceSha,
      sourceRef: expectedSourceRef,
      eventSourceSha: input.identity.eventSourceSha,
      observationId: discovery.id,
      observationRequestHash: discovery.requestHash,
      configRevisionId: revision.id,
      configRevision: revision.revision,
      configRevisionPayloadHash: revision.payloadHash,
      signedSnapshotDigest: revision.snapshotDigest,
      snapshotSignature: revision.snapshotSignature,
      snapshotSignatureKeyId: input.snapshotSignatureKeyId,
      snapshotSignaturePolicyRevision: input.snapshotSignaturePolicyRevision,
      workflowBundleSourceSha: registry.sourceSha,
      workflowBundlePayloadDigest: registry.payloadDigest,
      buildBinding,
      dependencyAuditException,
    });
  } catch (error) {
    if (error instanceof BuildRuntimeManifestError) {
      throw new ControlPlaneError(
        "서명된 build runtime manifest provenance를 생성할 수 없습니다.",
        error.code === "SNAPSHOT_SIGNATURE_IDENTITY_MISSING" ? 503 : 409,
        error.code,
      );
    }
    throw error;
  }
}

/** 운영 resolve와 격리 복구 rehearsal이 동일한 fail-closed 경계를 검증한다. */
export function assertResolvableConfigRevision(revision: {
  status: "DRAFT" | "ACTIVE" | "SUPERSEDED";
  activatedSnapshot: unknown;
  snapshotDigest: string | null;
  snapshotSignature: string | null;
}, signingKey: string): asserts revision is typeof revision & { activatedSnapshot: JsonValue } {
  if (revision.status === "DRAFT" || !revision.activatedSnapshot) {
    throw new ControlPlaneError("활성화된 Config revision이 없습니다.", 409, "NO_ACTIVE_CONFIG");
  }
  if (!verifySnapshot(
    revision.activatedSnapshot as JsonValue,
    signingKey,
    revision.snapshotDigest,
    revision.snapshotSignature,
  )) {
    throw new ControlPlaneError("Config snapshot 서명을 검증할 수 없습니다.", 409, "INVALID_CONFIG_SIGNATURE");
  }
}

function configPayloadFromSignedSnapshot(input: {
  revision: {
    id: string;
    revision: number;
    status: "DRAFT" | "ACTIVE" | "SUPERSEDED";
    payload: unknown;
    payloadHash: string;
    activatedSnapshot: unknown;
    snapshotDigest: string | null;
    snapshotSignature: string | null;
  };
  signingKey: string;
  appId: string;
  repoId: string;
  repoFullName: string;
}) {
  assertResolvableConfigRevision({
    status: input.revision.status,
    activatedSnapshot: input.revision.activatedSnapshot,
    snapshotDigest: input.revision.snapshotDigest,
    snapshotSignature: input.revision.snapshotSignature,
  }, input.signingKey);
  const snapshot = input.revision.activatedSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new ControlPlaneError(
      "서명된 Config snapshot envelope를 확인할 수 없습니다.",
      409,
      "INVALID_CONFIG_SIGNATURE",
    );
  }
  const snapshotRecord = snapshot as Record<string, unknown>;
  const snapshotPayload = snapshotRecord.payload;
  if (
    snapshotRecord.schemaVersion !== 1
    || snapshotRecord.appId !== input.appId
    || snapshotRecord.repoId !== input.repoId
    || snapshotRecord.repoFullName !== input.repoFullName
    || snapshotRecord.revision !== input.revision.revision
    || snapshotRecord.payloadHash !== input.revision.payloadHash
    || !snapshotPayload
    || typeof snapshotPayload !== "object"
    || Array.isArray(snapshotPayload)
    || jsonDigest(snapshotPayload as JsonValue) !== input.revision.payloadHash
    || jsonDigest(input.revision.payload as JsonValue) !== input.revision.payloadHash
  ) {
    throw new ControlPlaneError(
      "서명된 Config snapshot identity와 immutable revision이 일치하지 않습니다.",
      409,
      "INVALID_CONFIG_SIGNATURE",
    );
  }
  return configRevisionPayloadSchema.parse(snapshotPayload);
}
