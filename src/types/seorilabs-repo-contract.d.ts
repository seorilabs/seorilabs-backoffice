declare module "@seorilabs/repo-contract/fleet-migration-collector" {
  export interface FleetMigrationCollection extends Record<string, unknown> {
    state: "FIXTURE_COMPLETE" | "SHADOW_COMPLETE";
    collectionDigest: string;
    inventoryDigest: string;
    inventory: Record<string, unknown>;
    occurrence: {
      occurrenceId: string;
      runId: string;
      providerVectorDigest: string;
    };
  }

  export function createFleetMigrationReadOnlyCollector(
    configuration: Record<string, unknown>,
  ): {
    collect(input: Record<string, unknown>): Promise<FleetMigrationCollection>;
  };
  export function validateFleetMigrationCollection(value: unknown): {
    ok: boolean;
    diagnostics: string[];
  };
  export const fleetMigrationCollectorContract: {
    organizationId: string;
    githubApp: { installationId: string };
    detectorSource: { repositoryId: string };
  };
}

declare module "@seorilabs/repo-contract/fleet-migration-legacy-validator" {
  export function validateFleetMigrationLegacyDocument(
    request: Record<string, unknown>,
  ): Record<string, unknown>;
}

declare module "@seorilabs/repo-contract/fleet-migration" {
  import type { KeyObject } from "node:crypto";

  export function computeFleetEvidenceDigest(value: unknown): string;
  export function loadTrustedFleetMigrationInventoryBinding(input: {
    inventory: Record<string, unknown>;
    trustedInventoryKeys: Record<string, KeyObject>;
    now: string;
  }): Record<string, unknown>;
  export function validateFleetMigrationPlan(
    plan: Record<string, unknown>,
    input: {
      inventory: Record<string, unknown>;
      trustedInventoryBinding: Record<string, unknown>;
      now: string;
    },
  ): { ok: boolean; diagnostics: string[] };
  export const fleetMigrationContract: {
    initialBaseline: { ratification: Record<string, unknown> };
  };
}

declare module "@seorilabs/repo-contract/trusted-inventory-issuer" {
  import type { KeyObject } from "node:crypto";

  export function createFleetMigrationInventoryIssuer(
    configuration: Record<string, unknown> & { inventoryPublicKey: KeyObject },
  ): {
    issueAuthoritative(collection: unknown): Promise<Record<string, unknown>>;
  };
  export function validateFleetMigrationAuthoritativeInventory(
    issuance: Record<string, unknown>,
    publicKey: KeyObject,
    options: { now: string },
  ): { ok: boolean; diagnostics: string[] };
  export const fleetMigrationInventoryIssuerContract: {
    signingCredentialId: string;
    keyId: string;
    keyPurpose: string;
    signingKeyReadbackContract: string;
  };
}

declare module "@seorilabs/repo-contract/trusted-cleanup-executor" {
  import type { KeyObject } from "node:crypto";

  export function computeFleetCleanupApprovalScopeDigest(input: {
    organizationId: string;
    installationId: string;
    issuanceDigest: string;
    inventoryDigest: string;
    planDigest: string;
    repositoryId: string;
    fullName: string;
    sourceSha: string;
    issueNumber: number;
  }): string;
  export function createTrustedFleetCleanupGitHubAdapter(input: {
    provider: Record<string, (...args: never[]) => unknown>;
  }): Record<string, unknown>;
  export function createTrustedFleetCleanupStateStore(input: {
    provider: Record<string, (...args: never[]) => unknown>;
  }): Record<string, unknown>;
  export function createTrustedFleetCleanupExecutor(input: {
    organizationId: string;
    installationId: string;
    inventoryPublicKey: KeyObject;
    githubAdapter: Record<string, unknown>;
    stateStore: Record<string, unknown>;
    clock?: () => number;
  }): {
    execute(
      issuance: Record<string, unknown>,
      plan: Record<string, unknown>,
      request: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  };
  export const trustedFleetCleanupExecutorContract: {
    maximumReservationSeconds: number;
    maximumRuntimeApprovalSeconds: number;
  };
}
