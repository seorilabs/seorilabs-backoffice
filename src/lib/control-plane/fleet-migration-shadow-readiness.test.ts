import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { signSnapshot, verifySnapshot, type JsonValue } from "@/lib/control-plane/json";
import {
  evaluateFleetMigrationShadowReadiness,
  type FleetMigrationAppReadback,
  type FleetMigrationBackofficeReadback,
  type FleetMigrationRepositoryRegistrationReadback,
  type FleetMigrationShadowReadinessDependencies,
} from "@/lib/control-plane/fleet-migration-shadow-readiness";
import type {
  RepositoryInventoryClient,
  RepositoryReadbackVector,
} from "@/lib/control-plane/repository-discovery-backfill";

const NOW = new Date("2026-08-29T10:00:00.000Z");
const PRODUCT_SHA = "a".repeat(40);
const INFRA_SHA = "b".repeat(40);
const SNAPSHOT_SIGNING_KEY = "fleet-migration-shadow-readiness-test-key";

function registration(
  repoId: number,
  repoFullName: string,
  classification: "PRODUCT_APP" | "INFRA_REPO",
): FleetMigrationRepositoryRegistrationReadback {
  return {
    repoId: String(repoId),
    repoFullName,
    status: "MANAGED",
    classification,
    classificationDecisionVersion: 1,
    decision: {
      id: `classification-decision-${repoId}`,
      revision: 1,
      classification,
    },
  };
}

function productApp(): FleetMigrationAppReadback {
  const activatedSnapshot = { schemaVersion: 1 };
  const signed = signSnapshot(activatedSnapshot, SNAPSHOT_SIGNING_KEY);
  return {
    id: "app-product-0001",
    repoId: "101",
    repoFullName: "seorilabs/product",
    latestDiscovery: {
      id: "discovery-product-0001",
      sourceSha: PRODUCT_SHA,
    },
    activeConfigs: [{
      id: "config-product-active-0001",
      sourceObservationId: "discovery-product-0001",
      activatedSnapshot,
      snapshotDigest: signed.digest,
      snapshotSignature: signed.signature,
      activatedAt: "2026-08-29T09:55:00.000Z",
    }],
    platformFleetBinding: {
      id: "platform-binding-product-0001",
      sourceSha: PRODUCT_SHA,
      state: "COMPLIANT",
    },
    activeCredentialBindingCount: 2,
  };
}

function vector(
  repoId: number,
  repoFullName: string,
  sourceSha: string,
): RepositoryReadbackVector {
  return {
    repoId,
    repoFullName,
    name: repoFullName.split("/")[1],
    defaultBranch: "main",
    archived: false,
    private: true,
    fork: false,
    classificationDecisionRevision: 0,
    headSha: sourceSha,
  };
}

function dependencies(
  backoffice: FleetMigrationBackofficeReadback,
  options: {
    backofficeDrift?: boolean;
    paginationDrift?: boolean;
    providerDrift?: boolean;
  } = {},
): FleetMigrationShadowReadinessDependencies {
  const client: RepositoryInventoryClient = {
    request: async () => {
      throw new Error("unexpected direct request");
    },
  };
  const vectors = new Map<number, RepositoryReadbackVector>([
    [101, vector(101, "seorilabs/product", PRODUCT_SHA)],
    [202, vector(202, "seorilabs/infra", INFRA_SHA)],
  ]);
  let listCalls = 0;
  let readCalls = 0;
  let backofficeCalls = 0;
  return {
    getInstallationContext: async () => ({
      client,
      publicIdentity: {
        appId: "4124446",
        installationId: "142120077",
        targetId: "283115031",
        accountLogin: "seorilabs",
        targetType: "Organization",
        repositorySelection: "all",
        suspended: false,
      },
    }),
    listRepositories: async () => {
      listCalls += 1;
      return options.paginationDrift && listCalls === 2
        ? [{ repoId: 101 }, { repoId: 202 }, { repoId: 303 }]
        : [{ repoId: 101 }, { repoId: 202 }];
    },
    readRepository: async (_client, _organization, seed) => {
      readCalls += 1;
      const current = structuredClone(vectors.get(seed.repoId));
      if (!current) throw new Error("missing fixture vector");
      if (options.providerDrift && readCalls > 2 && seed.repoId === 101) {
        current.headSha = "e".repeat(40);
      }
      return current;
    },
    readBackoffice: async () => {
      backofficeCalls += 1;
      const current = structuredClone(backoffice);
      if (options.backofficeDrift && backofficeCalls === 2) {
        current.registrations[0].status = "NEEDS_INPUT";
      }
      return current;
    },
    verifyConfigSnapshot: (snapshot, digest, signature) => verifySnapshot(
      snapshot as JsonValue,
      SNAPSHOT_SIGNING_KEY,
      digest,
      signature,
    ),
    now: () => NOW,
  };
}

test("full-org pagination과 exact source/중앙 증거가 모두 맞으면 read-only readiness가 열린다", async () => {
  const app = productApp();
  app.activeCredentialBindingCount = 0;
  const result = await evaluateFleetMigrationShadowReadiness(dependencies({
    registrations: [
      registration(101, "seorilabs/product", "PRODUCT_APP"),
      registration(202, "seorilabs/infra", "INFRA_REPO"),
    ],
    apps: [app],
  }));
  assert.equal(result.state, "READY");
  assert.equal(result.providerRepositoryCount, 2);
  assert.equal(result.activeRepositoryCount, 2);
  assert.equal(result.archivedRepositoryCount, 0);
  assert.deepEqual(result.reasonCounts, {});
  assert.match(result.cohortDigest, /^[0-9a-f]{64}$/);
  assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.repositories[0].sourceSha, PRODUCT_SHA);
  assert.equal(result.repositories[0].activeCredentialBindingCount, 0);
});

test("GitHub repository identity casing만 다르면 중앙 binding drift로 오인하지 않는다", async () => {
  const app = productApp();
  app.repoFullName = "SeoriLabs/Product";

  const result = await evaluateFleetMigrationShadowReadiness(dependencies({
    registrations: [
      registration(101, "SEORILABS/PRODUCT", "PRODUCT_APP"),
      registration(202, "SEORILABS/INFRA", "INFRA_REPO"),
    ],
    apps: [app],
  }));

  assert.equal(result.state, "READY");
  assert.deepEqual(result.reasonCounts, {});
});

test("classification decision은 양수 revision과 collector evidence ID를 모두 요구한다", async () => {
  const invalidRevision = registration(101, "seorilabs/product", "PRODUCT_APP");
  invalidRevision.classificationDecisionVersion = 0;
  invalidRevision.decision!.revision = 0;
  const invalidId = registration(202, "seorilabs/infra", "INFRA_REPO");
  invalidId.decision!.id = "";

  const result = await evaluateFleetMigrationShadowReadiness(dependencies({
    registrations: [invalidRevision, invalidId],
    apps: [productApp()],
  }));

  assert.equal(result.state, "BLOCKED");
  assert.equal(result.reasonCounts.CLASSIFICATION_DECISION_INVALID, 2);
});

test("PlatformFleetBinding은 exact source와 COMPLIANT 상태가 모두 맞아야 한다", async () => {
  const app = productApp();
  app.platformFleetBinding = {
    id: "platform-binding-product-0001",
    sourceSha: "e".repeat(40),
    state: "PENDING",
  };

  const result = await evaluateFleetMigrationShadowReadiness(dependencies({
    registrations: [
      registration(101, "seorilabs/product", "PRODUCT_APP"),
      registration(202, "seorilabs/infra", "INFRA_REPO"),
    ],
    apps: [app],
  }));

  assert.equal(result.state, "BLOCKED");
  assert.deepEqual(
    result.repositories.find(({ repoId }) => repoId === "101")?.reasonCodes,
    [
      "PLATFORM_FLEET_BINDING_NOT_COMPLIANT",
      "PLATFORM_FLEET_BINDING_SOURCE_MISMATCH",
    ],
  );
});

test("ACTIVE snapshot 내용이나 서명이 바뀌면 readiness를 열지 않는다", async () => {
  const app = productApp();
  app.activeConfigs[0].activatedSnapshot = { schemaVersion: 2 };

  const tampered = await evaluateFleetMigrationShadowReadiness(dependencies({
    registrations: [
      registration(101, "seorilabs/product", "PRODUCT_APP"),
      registration(202, "seorilabs/infra", "INFRA_REPO"),
    ],
    apps: [app],
  }));
  assert.equal(tampered.state, "BLOCKED");
  assert.equal(tampered.reasonCounts.ACTIVE_SNAPSHOT_INVALID, 1);

  const invalidVerifier = dependencies({
    registrations: [
      registration(101, "seorilabs/product", "PRODUCT_APP"),
      registration(202, "seorilabs/infra", "INFRA_REPO"),
    ],
    apps: [productApp()],
  });
  invalidVerifier.verifyConfigSnapshot = () => {
    throw new Error("trusted verifier unavailable");
  };
  const unavailable = await evaluateFleetMigrationShadowReadiness(invalidVerifier);
  assert.equal(unavailable.state, "BLOCKED");
  assert.equal(unavailable.reasonCounts.ACTIVE_SNAPSHOT_INVALID, 1);
});

test("사람 결정과 ACTIVE 중앙 증거가 없으면 repo ID/source SHA별 이유로 fail-closed한다", async () => {
  const product = registration(101, "seorilabs/product", "PRODUCT_APP");
  product.status = "NEEDS_INPUT";
  product.classification = null;
  product.classificationDecisionVersion = 0;
  product.decision = null;
  const infra = registration(202, "seorilabs/infra", "INFRA_REPO");
  infra.classificationDecisionVersion = 0;
  infra.decision = null;
  const app = productApp();
  app.latestDiscovery = null;
  app.activeConfigs = [];
  app.platformFleetBinding = null;

  const result = await evaluateFleetMigrationShadowReadiness(dependencies({
    registrations: [product, infra],
    apps: [app],
  }));
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.reasonCounts.CLASSIFICATION_DECISION_MISSING, 2);
  assert.equal(result.reasonCounts.REPOSITORY_NOT_MANAGED, 1);
  assert.deepEqual(
    result.repositories.find(({ repoId }) => repoId === "101")?.reasonCodes,
    [
      "CLASSIFICATION_DECISION_MISSING",
      "CLASSIFICATION_MISSING",
      "NON_PRODUCT_APP_BINDING_PRESENT",
      "REPOSITORY_NOT_MANAGED",
    ],
  );
});

test("pagination 또는 exact source가 readback 사이에 바뀌면 결과를 만들지 않는다", async () => {
  const backoffice = {
    registrations: [
      registration(101, "seorilabs/product", "PRODUCT_APP"),
      registration(202, "seorilabs/infra", "INFRA_REPO"),
    ],
    apps: [productApp()],
  };
  await assert.rejects(
    evaluateFleetMigrationShadowReadiness(
      dependencies(backoffice, { paginationDrift: true }),
    ),
    /FLEET_MIGRATION_SHADOW_PAGINATION_DRIFT/,
  );
  await assert.rejects(
    evaluateFleetMigrationShadowReadiness(
      dependencies(backoffice, { providerDrift: true }),
    ),
    /FLEET_MIGRATION_SHADOW_PROVIDER_VECTOR_DRIFT/,
  );
  await assert.rejects(
    evaluateFleetMigrationShadowReadiness(
      dependencies(backoffice, { backofficeDrift: true }),
    ),
    /FLEET_MIGRATION_SHADOW_BACKOFFICE_VECTOR_DRIFT/,
  );
});

test("운영 이미지는 read-only readiness command를 번들한다", () => {
  const root = process.cwd();
  const packageJson = readFileSync(join(root, "package.json"), "utf8");
  const script = readFileSync(
    join(root, "scripts/fleet-migration-shadow-readiness.ts"),
    "utf8",
  );
  assert.match(packageJson, /scripts\/fleet-migration-shadow-readiness\.ts/);
  assert.match(script, /evaluateFleetMigrationShadowReadiness/);
  assert.doesNotMatch(script, /create|update|delete|upsert|mutation/i);
});
