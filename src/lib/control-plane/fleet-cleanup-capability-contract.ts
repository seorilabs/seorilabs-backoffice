import { createHash, type KeyObject } from "node:crypto";

import {
  loadTrustedFleetMigrationInventoryBinding,
  validateFleetMigrationPlan,
} from "@seorilabs/repo-contract/fleet-migration";
import {
  computeFleetCleanupApprovalScopeDigest,
} from "@seorilabs/repo-contract/trusted-cleanup-executor";
import {
  fleetMigrationInventoryIssuerContract,
  validateFleetMigrationAuthoritativeInventory,
} from "@seorilabs/repo-contract/trusted-inventory-issuer";
import { z } from "zod";

import { canonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";

export const FLEET_CLEANUP_ORGANIZATION_ID = "283115031";
export const FLEET_CLEANUP_INSTALLATION_ID = "142120077";
export const FLEET_CLEANUP_CAPABILITY_TTL_SECONDS = 15 * 60;
export const FLEET_CLEANUP_RESERVATION_TTL_SECONDS = 5 * 60;

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[\p{L}\p{N}._@+ -]+(?:\/[\p{L}\p{N}._@+ -]+)*$/u;
const PRIVATE_VALUE = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/iu,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /["']private_key["']\s*:/u,
];

const publicObject = z.record(z.unknown());
const replacementSchema = z.object({
  path: z.string().min(1).max(512).regex(SAFE_PATH),
  contentBase64: z.string().min(4).max(Math.ceil(1024 * 1024 * 4 / 3) + 4),
}).strict();

const issueSchema = z.object({
  operation: z.literal("ISSUE"),
  issuance: publicObject,
  plan: publicObject,
  repositoryId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
  issueNumber: z.number().int().positive(),
  ttlSeconds: z.number().int().positive().max(FLEET_CLEANUP_CAPABILITY_TTL_SECONDS),
  replacements: z.array(replacementSchema).max(100),
}).strict();

const executeSchema = z.object({
  operation: z.literal("EXECUTE"),
  capabilityId: z.string().regex(ID),
  approvalScopeDigest: z.string().regex(DIGEST),
  runId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
  runAttempt: z.string().regex(/^[1-9][0-9]{0,15}$/u),
}).strict();

export const fleetCleanupCapabilityRequestSchema = z.discriminatedUnion("operation", [
  issueSchema,
  executeSchema,
]);

export type FleetCleanupCapabilityRequest = z.infer<typeof fleetCleanupCapabilityRequestSchema>;
export type FleetCleanupIssueRequest = z.infer<typeof issueSchema>;
export type FleetCleanupExecuteRequest = z.infer<typeof executeSchema>;

export interface FleetCleanupFileAction {
  operation: "DELETE" | "REWRITE";
  path: string;
  expectedMode: "100644" | "100755";
  expectedBlobSha: string;
  expectedContentDigest: string;
  replacementDigest: string;
  replacementBindingDigest: string;
  idempotencyKey: string;
}

export interface FleetCleanupReplacementFile {
  path: string;
  contentBase64: string;
  contentDigest: string;
}

export interface FleetCleanupExactScope {
  organizationId: string;
  installationId: string;
  issuanceDigest: string;
  inventoryDigest: string;
  planDigest: string;
  repositoryId: string;
  repositoryFullName: string;
  sourceSha: string;
  treeSha: string;
  chainHeadDigest: string | null;
  issueNumber: number;
  approvalScopeDigest: string;
  fileActionSet: FleetCleanupFileAction[];
  fileActionSetDigest: string;
  replacementFiles: FleetCleanupReplacementFile[];
  replacementFilesDigest: string;
}

interface FleetCleanupPlanChange extends Record<string, unknown> {
  operation: string;
  path: string;
  outcome: string;
  reasonCodes: unknown[];
  gitEntry: { mode: "100644" | "100755"; objectSha: string };
  contentDigest: string;
  replacementDigest: string;
  replacementBindingDigest: string;
  idempotencyKey: string;
}

interface FleetCleanupPlanRepository extends Record<string, unknown> {
  repositoryId: string;
  fullName: string;
  sourceRef: string;
  sourceSha: string;
  fork: boolean;
  outcome: string;
  reasonCodes: unknown[];
  changes: FleetCleanupPlanChange[];
}

interface FleetCleanupPlan extends Record<string, unknown> {
  mode: string;
  executionAllowed: boolean;
  outcome: string;
  reasonCodes: unknown[];
  planDigest: string;
  inventory: {
    inventoryId: string;
    binding: { inventoryDigest: string };
    chainHead?: { state: string; chainHeadDigest: string };
  };
  repositories: FleetCleanupPlanRepository[];
}

interface FleetCleanupIssuance extends Record<string, unknown> {
  authoritative: boolean;
  readyForPlanning: boolean;
  issuanceDigest: string;
  inventoryDigest: string;
  inventory: {
    inventoryId: string;
    organization: { id: string; login: string };
    coverage: { installationId: string };
    lineage: { mode: string };
    repositories: Array<{
      repository: { id: string; fullName: string; defaultRef: string; sourceSha: string };
      observation: { treeSha: string };
    }>;
  };
}

function fail(code: string): never {
  throw new Error(code);
}

function digest(value: unknown): string {
  return `sha256:${jsonDigest(value as JsonValue)}`;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decodeReplacement(value: z.infer<typeof replacementSchema>): FleetCleanupReplacementFile {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.contentBase64)) {
    fail("FLEET_CLEANUP_REPLACEMENT_BASE64_INVALID");
  }
  const bytes = Buffer.from(value.contentBase64, "base64");
  try {
    if (bytes.length < 1 || bytes.length > 1024 * 1024) {
      fail("FLEET_CLEANUP_REPLACEMENT_SIZE_INVALID");
    }
    const text = bytes.toString("utf8");
    if (
      Buffer.from(text, "utf8").compare(bytes) !== 0
      || text.includes("\0")
      || PRIVATE_VALUE.some((pattern) => pattern.test(text))
    ) fail("FLEET_CLEANUP_REPLACEMENT_PRIVATE_SURFACE_REJECTED");
    return {
      path: value.path,
      contentBase64: bytes.toString("base64"),
      contentDigest: sha256(bytes),
    };
  } finally {
    bytes.fill(0);
  }
}

function validAuthoritativePlan(input: {
  issuance: Record<string, unknown>;
  plan: Record<string, unknown>;
  publicKey: KeyObject;
  now: Date;
}): { issuance: FleetCleanupIssuance; plan: FleetCleanupPlan } {
  const issuance = structuredClone(input.issuance) as unknown as FleetCleanupIssuance;
  const plan = structuredClone(input.plan) as unknown as FleetCleanupPlan;
  const now = input.now.toISOString();
  const issuanceValidation = validateFleetMigrationAuthoritativeInventory(
    issuance,
    input.publicKey,
    { now },
  );
  if (
    issuanceValidation.ok !== true
    || issuance.authoritative !== true
    || issuance.readyForPlanning !== true
    || issuance.inventory?.organization?.id !== FLEET_CLEANUP_ORGANIZATION_ID
    || issuance.inventory?.organization?.login !== "seorilabs"
    || issuance.inventory?.coverage?.installationId !== FLEET_CLEANUP_INSTALLATION_ID
    || issuance.inventory?.lineage?.mode !== "BOOTSTRAP"
    || !DIGEST.test(issuance.issuanceDigest ?? "")
    || !DIGEST.test(issuance.inventoryDigest ?? "")
  ) fail("FLEET_CLEANUP_CAPABILITY_INVENTORY_INVALID");
  let trustedInventoryBinding;
  try {
    trustedInventoryBinding = loadTrustedFleetMigrationInventoryBinding({
      inventory: issuance.inventory,
      trustedInventoryKeys: {
        [fleetMigrationInventoryIssuerContract.keyId]: input.publicKey,
      },
      now,
    });
  } catch {
    fail("FLEET_CLEANUP_CAPABILITY_INVENTORY_INVALID");
  }
  const planValidation = validateFleetMigrationPlan(plan, {
    inventory: issuance.inventory,
    trustedInventoryBinding,
    now,
  });
  if (
    planValidation.ok !== true
    || plan.mode !== "PLAN_ONLY"
    || plan.executionAllowed !== false
    || plan.outcome !== "READY_FOR_REVIEW"
    || !Array.isArray(plan.reasonCodes)
    || plan.reasonCodes.length !== 0
    || plan.inventory?.inventoryId !== issuance.inventory.inventoryId
    || plan.inventory?.binding?.inventoryDigest !== issuance.inventoryDigest
    || !DIGEST.test(plan.planDigest ?? "")
  ) fail("FLEET_CLEANUP_CAPABILITY_PLAN_INVALID");
  return { issuance, plan };
}

export function validateFleetCleanupExactScope(input: {
  issuance: Record<string, unknown>;
  plan: Record<string, unknown>;
  repositoryId: string;
  issueNumber: number;
  replacements: readonly z.infer<typeof replacementSchema>[];
  publicKey: KeyObject;
  now: Date;
}): FleetCleanupExactScope {
  if (!Number.isFinite(input.now.getTime())) fail("FLEET_CLEANUP_CAPABILITY_TIME_INVALID");
  const { issuance, plan } = validAuthoritativePlan(input);
  const repository = plan.repositories?.find(
    (candidate) => candidate.repositoryId === input.repositoryId,
  );
  const inventoryRepository = issuance.inventory.repositories?.find(
    (candidate) => candidate.repository?.id === input.repositoryId,
  );
  if (
    !repository
    || !inventoryRepository
    || repository.outcome !== "READY_FOR_REVIEW"
    || !Array.isArray(repository.reasonCodes)
    || repository.reasonCodes.length !== 0
    || !Array.isArray(repository.changes)
    || repository.changes.length < 1
    || repository.changes.length > 100
    || !REPOSITORY.test(repository.fullName ?? "")
    || repository.fullName !== inventoryRepository.repository?.fullName
    || repository.sourceRef !== inventoryRepository.repository?.defaultRef
    || !SHA.test(repository.sourceSha ?? "")
    || repository.sourceSha !== inventoryRepository.repository?.sourceSha
    || !SHA.test(inventoryRepository.observation?.treeSha ?? "")
    || repository.fork !== false
  ) fail("FLEET_CLEANUP_CAPABILITY_REPOSITORY_INVALID");

  const paths = new Set<string>();
  const fileActionSet: FleetCleanupFileAction[] = repository.changes.map((change) => {
    if (
      !["DELETE", "REWRITE"].includes(change.operation)
      || typeof change.path !== "string"
      || !SAFE_PATH.test(change.path)
      || paths.has(change.path.toLowerCase())
      || change.outcome !== "READY_FOR_REVIEW"
      || !Array.isArray(change.reasonCodes)
      || change.reasonCodes.length !== 0
      || !["100644", "100755"].includes(change.gitEntry?.mode)
      || !SHA.test(change.gitEntry?.objectSha ?? "")
      || !DIGEST.test(change.contentDigest ?? "")
      || !DIGEST.test(change.replacementDigest ?? "")
      || !DIGEST.test(change.replacementBindingDigest ?? "")
      || !DIGEST.test(change.idempotencyKey ?? "")
    ) fail("FLEET_CLEANUP_CAPABILITY_FILE_ACTION_INVALID");
    paths.add(change.path.toLowerCase());
    return {
      operation: change.operation as "DELETE" | "REWRITE",
      path: change.path,
      expectedMode: change.gitEntry.mode,
      expectedBlobSha: change.gitEntry.objectSha,
      expectedContentDigest: change.contentDigest,
      replacementDigest: change.replacementDigest,
      replacementBindingDigest: change.replacementBindingDigest,
      idempotencyKey: change.idempotencyKey,
    };
  }).sort((left: FleetCleanupFileAction, right: FleetCleanupFileAction) => (
    Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8"))
  ));
  const replacements = input.replacements.map(decodeReplacement)
    .sort((left, right) => Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));
  const replacementByPath = new Map(replacements.map((replacement) => [replacement.path, replacement]));
  if (
    replacementByPath.size !== replacements.length
    || fileActionSet.some((action) => (
      action.operation === "REWRITE"
        ? replacementByPath.get(action.path)?.contentDigest !== action.replacementDigest
        : replacementByPath.has(action.path)
    ))
    || replacements.some((replacement) => !fileActionSet.some((action) => (
      action.operation === "REWRITE" && action.path === replacement.path
    )))
  ) fail("FLEET_CLEANUP_CAPABILITY_REPLACEMENT_BINDING_INVALID");

  const approvalScopeDigest = computeFleetCleanupApprovalScopeDigest({
    organizationId: FLEET_CLEANUP_ORGANIZATION_ID,
    installationId: FLEET_CLEANUP_INSTALLATION_ID,
    issuanceDigest: issuance.issuanceDigest,
    inventoryDigest: issuance.inventoryDigest,
    planDigest: plan.planDigest,
    repositoryId: repository.repositoryId,
    fullName: repository.fullName,
    sourceSha: repository.sourceSha,
    issueNumber: input.issueNumber,
  });
  const chainHeadDigest = plan.inventory.chainHead?.state === "VERIFIED"
    ? plan.inventory.chainHead.chainHeadDigest
    : null;
  const scope: FleetCleanupExactScope = {
    organizationId: FLEET_CLEANUP_ORGANIZATION_ID,
    installationId: FLEET_CLEANUP_INSTALLATION_ID,
    issuanceDigest: issuance.issuanceDigest,
    inventoryDigest: issuance.inventoryDigest,
    planDigest: plan.planDigest,
    repositoryId: repository.repositoryId,
    repositoryFullName: repository.fullName,
    sourceSha: repository.sourceSha,
    treeSha: inventoryRepository.observation.treeSha,
    chainHeadDigest,
    issueNumber: input.issueNumber,
    approvalScopeDigest,
    fileActionSet,
    fileActionSetDigest: digest({
      contract: "seorilabs-fleet-cleanup-file-action-set-v1",
      repositoryId: repository.repositoryId,
      sourceSha: repository.sourceSha,
      treeSha: inventoryRepository.observation.treeSha,
      actions: fileActionSet,
    }),
    replacementFiles: replacements,
    replacementFilesDigest: digest({
      contract: "seorilabs-fleet-cleanup-replacement-files-v1",
      files: replacements.map(({ path, contentDigest }) => ({ path, contentDigest })),
    }),
  };
  if (!DIGEST.test(scope.approvalScopeDigest) || !DIGEST.test(scope.fileActionSetDigest)) {
    fail("FLEET_CLEANUP_CAPABILITY_SCOPE_INVALID");
  }
  return Object.freeze(structuredClone(scope));
}

export function fleetCleanupCapabilityRequestDigest(input: {
  requestId: string;
  approvedBy: string;
  ttlSeconds: number;
  scope: FleetCleanupExactScope;
  issuance: Record<string, unknown>;
  plan: Record<string, unknown>;
}): string {
  return digest({
    contract: "seorilabs-fleet-cleanup-capability-request-v1",
    requestId: input.requestId,
    approvedBy: input.approvedBy,
    ttlSeconds: input.ttlSeconds,
    issuance: input.issuance,
    plan: input.plan,
    scope: input.scope,
  });
}

export function fleetCleanupPublicCapability(input: {
  id: string;
  state: string;
  approvedAt: Date;
  expiresAt: Date;
  scope: FleetCleanupExactScope;
  duplicate: boolean;
}) {
  return Object.freeze({
    schemaVersion: 1,
    contract: "seorilabs-fleet-cleanup-capability-v1",
    capabilityId: input.id,
    state: input.state,
    duplicate: input.duplicate,
    action: "READY_PR_ONLY",
    repository: {
      id: input.scope.repositoryId,
      fullName: input.scope.repositoryFullName,
      sourceSha: input.scope.sourceSha,
      treeSha: input.scope.treeSha,
    },
    issuanceDigest: input.scope.issuanceDigest,
    inventoryDigest: input.scope.inventoryDigest,
    planDigest: input.scope.planDigest,
    chainHeadDigest: input.scope.chainHeadDigest,
    issueNumber: input.scope.issueNumber,
    approvalScopeDigest: input.scope.approvalScopeDigest,
    fileActionSetDigest: input.scope.fileActionSetDigest,
    replacementFilesDigest: input.scope.replacementFilesDigest,
    approvedAt: input.approvedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  });
}

export function canonicalFleetCleanupJson(value: unknown): string {
  return canonicalJson(value as JsonValue);
}
