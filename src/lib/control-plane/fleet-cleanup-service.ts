import { createTrustedFleetCleanupExecutor } from "seorilabs-org-contracts/repo-contract/trusted-cleanup-executor";

import {
  createFleetCleanupStateProvider,
  issueFleetCleanupCapability,
  readFleetCleanupCapability,
} from "@/lib/control-plane/fleet-cleanup-authority";
import {
  FLEET_CLEANUP_INSTALLATION_ID,
  FLEET_CLEANUP_ORGANIZATION_ID,
  validateFleetCleanupExactScope,
  type FleetCleanupExecuteRequest,
  type FleetCleanupIssueRequest,
  type FleetCleanupReplacementFile,
} from "@/lib/control-plane/fleet-cleanup-capability-contract";
import { withFleetCleanupGithub } from "@/lib/control-plane/fleet-cleanup-github-provider";
import { loadFleetMigrationInventoryPublicIdentity } from "@/lib/control-plane/fleet-migration-inventory-issuer-adapter";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`FLEET_CLEANUP_${name}_REQUIRED`);
  return value;
}

async function publicIdentity() {
  return loadFleetMigrationInventoryPublicIdentity({
    root: required("FLEET_MIGRATION_INVENTORY_PUBLIC_ROOT"),
    publicKeyFile: required("FLEET_MIGRATION_INVENTORY_PUBLIC_KEY_FILE"),
    publicCatalogFile: required("FLEET_MIGRATION_INVENTORY_PUBLIC_CATALOG_FILE"),
  });
}

export async function approveFleetCleanupCapability(input: {
  requestId: string;
  approvedBy: string;
  body: FleetCleanupIssueRequest;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const identity = await publicIdentity();
  const scope = validateFleetCleanupExactScope({
    issuance: input.body.issuance,
    plan: input.body.plan,
    repositoryId: input.body.repositoryId,
    issueNumber: input.body.issueNumber,
    replacements: input.body.replacements,
    publicKey: identity.publicKey,
    now,
  });
  return issueFleetCleanupCapability({
    requestId: input.requestId,
    approvedBy: input.approvedBy,
    ttlSeconds: input.body.ttlSeconds,
    scope,
    issuance: input.body.issuance,
    plan: input.body.plan,
    now,
  });
}

export async function executeFleetCleanupCapability(input: {
  executorIdentity: {
    repositoryId: string;
    runId: string;
    runAttempt: string;
  };
  body: FleetCleanupExecuteRequest;
  now?: () => Date;
}) {
  if (
    input.body.runId !== input.executorIdentity.runId
    || input.body.runAttempt !== input.executorIdentity.runAttempt
  ) throw new Error("FLEET_CLEANUP_EXECUTOR_PRINCIPAL_MISMATCH");
  const capability = await readFleetCleanupCapability({ capabilityId: input.body.capabilityId });
  if (capability.approvalScopeDigest !== input.body.approvalScopeDigest) {
    throw new Error("FLEET_CLEANUP_CAPABILITY_SCOPE_MISMATCH");
  }
  const identity = await publicIdentity();
  const issuance = capability.issuance as Record<string, unknown>;
  const plan = capability.plan as Record<string, unknown>;
  const replacements = capability.replacementFiles as unknown as FleetCleanupReplacementFile[];
  const scope = validateFleetCleanupExactScope({
    issuance,
    plan,
    repositoryId: capability.authority.repositoryId.toString(),
    issueNumber: capability.issueNumber,
    replacements: replacements.map(({ path, contentBase64 }) => ({ path, contentBase64 })),
    publicKey: identity.publicKey,
    now: new Date(input.now?.() ?? Date.now()),
  });
  if (
    capability.state !== "ACTIVE" && capability.state !== "COMPLETED"
    || capability.authority.organizationId !== scope.organizationId
    || capability.authority.installationId !== scope.installationId
    || capability.authority.repositoryId.toString() !== scope.repositoryId
    || capability.authority.repositoryFullName !== scope.repositoryFullName
    || capability.authority.sourceSha !== scope.sourceSha
    || capability.authority.treeSha !== scope.treeSha
    || capability.authority.issuanceDigest !== scope.issuanceDigest
    || capability.authority.inventoryDigest !== scope.inventoryDigest
    || capability.authority.planDigest !== scope.planDigest
    || capability.authority.chainHeadDigest !== scope.chainHeadDigest
    || capability.approvalScopeDigest !== scope.approvalScopeDigest
    || capability.fileActionSetDigest !== scope.fileActionSetDigest
    || capability.replacementFilesDigest !== scope.replacementFilesDigest
    || jsonDigest(capability.fileActionSet as JsonValue) !== jsonDigest(scope.fileActionSet as unknown as JsonValue)
    || jsonDigest(capability.replacementFiles as JsonValue) !== jsonDigest(scope.replacementFiles as unknown as JsonValue)
  ) throw new Error("FLEET_CLEANUP_CAPABILITY_EXECUTION_BINDING_MISMATCH");
  const state = createFleetCleanupStateProvider({
    capabilityId: capability.id,
    now: () => new Date(input.now?.() ?? Date.now()),
  });
  const receipt = await withFleetCleanupGithub({
    capabilityId: capability.id,
    installationId: FLEET_CLEANUP_INSTALLATION_ID,
    repositoryId: scope.repositoryId,
    repositoryFullName: scope.repositoryFullName,
    execute: async (githubAdapter) => {
      const executor = createTrustedFleetCleanupExecutor({
        organizationId: FLEET_CLEANUP_ORGANIZATION_ID,
        installationId: FLEET_CLEANUP_INSTALLATION_ID,
        inventoryPublicKey: identity.publicKey,
        githubAdapter,
        stateStore: state.store,
        clock: input.now ? () => input.now!().getTime() : () => Date.now(),
      });
      return executor.execute(issuance, plan, {
        repositoryId: scope.repositoryId,
        issueNumber: scope.issueNumber,
        runId: `github-actions-${input.executorIdentity.runId}`,
        workerId: `github-actions:${input.executorIdentity.repositoryId}:${input.executorIdentity.runId}`,
      });
    },
  });
  const receiptValue = receipt as {
    state: string;
    organizationId: string;
    installationId: string;
    issuanceDigest: string;
    inventoryDigest: string;
    planDigest: string;
    receiptDigest: string;
    repository: {
      id: string;
      fullName: string;
      sourceSha: string;
      defaultRef: string;
      treeSha: string;
    };
  };
  if (
    receiptValue.state !== "READY_PR_CREATED"
    || receiptValue.organizationId !== capability.authority.organizationId
    || receiptValue.installationId !== capability.authority.installationId
    || receiptValue.issuanceDigest !== capability.authority.issuanceDigest
    || receiptValue.inventoryDigest !== capability.authority.inventoryDigest
    || receiptValue.planDigest !== capability.authority.planDigest
    || receiptValue.repository.id !== capability.authority.repositoryId.toString()
    || receiptValue.repository.fullName !== capability.authority.repositoryFullName
    || receiptValue.repository.sourceSha !== capability.authority.sourceSha
    || receiptValue.repository.treeSha !== capability.authority.treeSha
  ) throw new Error("FLEET_CLEANUP_RECEIPT_CAPABILITY_MISMATCH");
  return Object.freeze({
    contract: "seorilabs-fleet-cleanup-execution-response-v1",
    state: receiptValue.state,
    capabilityId: capability.id,
    approvalScopeDigest: capability.approvalScopeDigest,
    organizationId: receiptValue.organizationId,
    installationId: receiptValue.installationId,
    repository: structuredClone(receiptValue.repository),
    digests: {
      issuanceDigest: receiptValue.issuanceDigest,
      inventoryDigest: receiptValue.inventoryDigest,
      planDigest: receiptValue.planDigest,
      receiptDigest: receiptValue.receiptDigest,
    },
    actionScope: {
      chainHeadDigest: capability.authority.chainHeadDigest,
      fileActionSetDigest: capability.fileActionSetDigest,
      replacementFilesDigest: capability.replacementFilesDigest,
    },
    receipt,
  });
}
