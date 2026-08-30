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
  export function computeFleetEvidenceDigest(value: unknown): string;
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
  export const fleetMigrationInventoryIssuerContract: {
    signingCredentialId: string;
    keyId: string;
    keyPurpose: string;
    signingKeyReadbackContract: string;
  };
}
