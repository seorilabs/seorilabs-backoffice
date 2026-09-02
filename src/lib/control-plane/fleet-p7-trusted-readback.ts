import type { KeyObject } from "node:crypto";

import {
  createFleetCallerMigrationReadback,
  loadTrustedFleetMigrationInventoryBinding,
} from "seorilabs-org-contracts/repo-contract/fleet-migration";
import { fleetMigrationInventoryIssuerContract } from "seorilabs-org-contracts/repo-contract/trusted-inventory-issuer";

import type { FleetP7GitHubPublicReadback } from "@/lib/control-plane/fleet-p7-github-readback";

const PRIVATE_KEY = /^(?:authorization|bytes|cookie|credentialValue|password|payload|privateKey|privateKeyPem|rawSecret|secret|secretValue|token)$/iu;
const PRIVATE_VALUE = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
];

type TrustedBindingLoader = typeof loadTrustedFleetMigrationInventoryBinding;
type CallerReadbackFactory = typeof createFleetCallerMigrationReadback;

export interface FleetP7TrustedAggregateReadback {
  centralContract: FleetP7GitHubPublicReadback["centralContract"];
  installation: Record<string, unknown> | null;
  organizationCustomProperties: Array<Record<string, unknown>> | null;
  protection: FleetP7GitHubPublicReadback["protection"];
  defaultBranchOrgContractCallers: Array<{ fullName: string }> | null;
  cloudBuildBindings: null;
  callerMigration: Record<string, unknown>;
  publicRepositories: Array<{ fullName: string; requiresRelease: boolean }>;
}

function fail(code: string): never {
  throw new Error(code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    fail("FLEET_P7_TRUSTED_READBACK_INVALID");
  }
  return value as Record<string, unknown>;
}

function assertSecretFree(value: unknown): void {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === "string") {
      if (PRIVATE_VALUE.some((pattern) => pattern.test(item))) {
        fail("FLEET_P7_TRUSTED_READBACK_PRIVATE_SURFACE_REJECTED");
      }
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      if (PRIVATE_KEY.test(key)) fail("FLEET_P7_TRUSTED_READBACK_PRIVATE_SURFACE_REJECTED");
      visit(nested);
    }
  };
  visit(value);
}

function publicRepositories(inventory: Record<string, unknown>) {
  const repositories = inventory.repositories;
  if (!Array.isArray(repositories)) fail("FLEET_P7_TRUSTED_INVENTORY_INVALID");
  return repositories.flatMap((item) => {
    const repository = record(record(item).repository);
    if (repository.private !== false) return [];
    if (typeof repository.fullName !== "string" || typeof repository.classification !== "string") {
      fail("FLEET_P7_TRUSTED_INVENTORY_INVALID");
    }
    return [{
      fullName: repository.fullName,
      requiresRelease: repository.classification === "PRODUCT_APP",
    }];
  }).sort((left, right) => left.fullName.localeCompare(right.fullName));
}

export async function createFleetP7TrustedAggregateReadback(input: {
  issuance: Record<string, unknown>;
  publicKey: KeyObject;
  now: Date;
  readGitHub: (inventory: Record<string, unknown>) => Promise<FleetP7GitHubPublicReadback>;
  loadBinding?: TrustedBindingLoader;
  createCallerReadback?: CallerReadbackFactory;
}): Promise<FleetP7TrustedAggregateReadback> {
  if (!Number.isFinite(input.now.getTime())) fail("FLEET_P7_TRUSTED_READBACK_TIME_INVALID");
  const inventory = structuredClone(record(input.issuance.inventory));
  assertSecretFree(inventory);
  const loadBinding = input.loadBinding ?? loadTrustedFleetMigrationInventoryBinding;
  const createCallerReadback = input.createCallerReadback ?? createFleetCallerMigrationReadback;
  const trustedInventoryBinding = loadBinding({
    inventory,
    trustedInventoryKeys: {
      [fleetMigrationInventoryIssuerContract.keyId]: input.publicKey,
    },
    now: input.now.toISOString(),
  });
  const github = await input.readGitHub(inventory);
  const callerMigration = createCallerReadback({
    inventory,
    trustedInventoryBinding,
    currentCentralSourceSha: github.currentCentralSourceSha,
    now: input.now.toISOString(),
  });
  const aggregate: FleetP7TrustedAggregateReadback = {
    centralContract: github.centralContract,
    installation: github.installation,
    organizationCustomProperties: github.organizationCustomProperties,
    protection: github.protection,
    defaultBranchOrgContractCallers: github.defaultBranchOrgContractCallers,
    // 조회하지 않은 GCP 상태를 desired state로 꾸미지 않는다. 실제 적용 여부와 별개로
    // 중앙 p7-gate-report가 MACHINE_BLOCKED로 누락된 관측을 표시한다.
    cloudBuildBindings: null,
    callerMigration,
    publicRepositories: publicRepositories(inventory),
  };
  assertSecretFree(aggregate);
  return aggregate;
}
