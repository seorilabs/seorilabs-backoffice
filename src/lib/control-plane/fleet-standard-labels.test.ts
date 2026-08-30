import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  FLEET_STANDARD_LABEL_ACTION,
  fleetCustomLabelsPreserved,
  fleetStandardLabelContractSourceConfig,
  fleetStandardLabelOperation,
  normalizeFleetRepositoryLabels,
  parseFleetStandardLabelContract,
} from "@/lib/control-plane/fleet-standard-labels";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const catalog = {
  schemaVersion: 1 as const,
  catalogVersion: "fixture-standard-labels/v1",
  strategy: "UPSERT_FIXED_PRESERVE_CUSTOM" as const,
  labels: [
    { name: "P1", color: "B60205", description: "최우선" },
    { name: "autopilot", color: "EDEDED", description: "자동 처리" },
  ],
};
const catalogDigest = `sha256:${jsonDigest(catalog as unknown as JsonValue)}`;
const config = {
  repositoryId: "123",
  repositoryFullName: "seorilabs/.github" as const,
  sourceSha: "a".repeat(40),
  catalogPath: "contracts/fleet-standard-labels.json" as const,
  catalogBlobSha: "b".repeat(40),
  expectedCatalogDigest: catalogDigest,
  packageExport: "@seorilabs/repo-contract/standard-labels" as const,
};

test("Fleet 표준 label 계약은 exact 중앙 source/blob/digest만 받아들인다", () => {
  const contract = parseFleetStandardLabelContract({
    config,
    blobSha: config.catalogBlobSha,
    text: JSON.stringify(catalog),
  });
  assert.equal(contract.catalogDigest, catalogDigest);
  assert.equal(contract.packageExport, "@seorilabs/repo-contract/standard-labels");
  assert.deepEqual(contract.catalog.labels.map((label) => label.name), ["P1", "autopilot"]);

  assert.throws(() => parseFleetStandardLabelContract({
    config,
    blobSha: "c".repeat(40),
    text: JSON.stringify(catalog),
  }), /FLEET_STANDARD_LABEL_CONTRACT_BLOB_MISMATCH/u);
  assert.throws(() => parseFleetStandardLabelContract({
    config: { ...config, expectedCatalogDigest: `sha256:${"d".repeat(64)}` },
    blobSha: config.catalogBlobSha,
    text: JSON.stringify(catalog),
  }), /FLEET_STANDARD_LABEL_CATALOG_DIGEST_MISMATCH/u);
  assert.throws(() => parseFleetStandardLabelContract({
    config,
    blobSha: config.catalogBlobSha,
    text: JSON.stringify({ ...catalog, labels: [...catalog.labels, { ...catalog.labels[0], name: "p1" }] }),
  }));
});

test("환경 설정은 중앙 repository ID와 immutable source/blob/catalog digest를 모두 요구한다", () => {
  assert.deepEqual(fleetStandardLabelContractSourceConfig({
    FLEET_STANDARD_LABELS_CONTRACT_REPOSITORY_ID: "123",
    FLEET_STANDARD_LABELS_CONTRACT_SOURCE_SHA: "A".repeat(40),
    FLEET_STANDARD_LABELS_CATALOG_BLOB_SHA: "B".repeat(40),
    FLEET_STANDARD_LABELS_CATALOG_DIGEST: catalogDigest.toUpperCase(),
  }), config);
  assert.throws(() => fleetStandardLabelContractSourceConfig({
    FLEET_STANDARD_LABELS_CONTRACT_REPOSITORY_ID: "123",
    FLEET_STANDARD_LABELS_CONTRACT_SOURCE_SHA: "main",
    FLEET_STANDARD_LABELS_CATALOG_BLOB_SHA: "b".repeat(40),
    FLEET_STANDARD_LABELS_CATALOG_DIGEST: catalogDigest,
  }), /FLEET_STANDARD_LABEL_CONTRACT_SOURCE_INVALID/u);
});

test("운영 Deployment는 secret이 아닌 immutable 중앙 source identity를 모두 주입한다", () => {
  const deployment = readFileSync(join(process.cwd(), "k8s/deployment.yaml"), "utf8");
  const environment = Object.fromEntries([
    "FLEET_STANDARD_LABELS_CONTRACT_REPOSITORY_ID",
    "FLEET_STANDARD_LABELS_CONTRACT_SOURCE_SHA",
    "FLEET_STANDARD_LABELS_CATALOG_BLOB_SHA",
    "FLEET_STANDARD_LABELS_CATALOG_DIGEST",
  ].map((name) => {
    const match = deployment.match(new RegExp(`- name: ${name}\\n\\s+value: "([^"\\n]+)"`, "u"));
    assert.ok(match, `${name}이 deployment에 있어야 한다`);
    return [name, match[1]];
  }));
  const configured = fleetStandardLabelContractSourceConfig(environment);
  assert.equal(configured.repositoryFullName, "seorilabs/.github");
  assert.notEqual(configured.sourceSha, configured.catalogBlobSha);
  assert.doesNotMatch(deployment, /FLEET_STANDARD_LABELS_(?:TOKEN|PASSWORD|PRIVATE_KEY)/u);
});

test("operation은 중앙 catalog payload와 repository를 exact idempotency에 결합한다", () => {
  const contract = parseFleetStandardLabelContract({
    config,
    blobSha: config.catalogBlobSha,
    text: JSON.stringify(catalog),
  });
  const operation = fleetStandardLabelOperation({
    contract,
    repositoryId: "456",
    repositoryFullName: "seorilabs/example",
  });
  assert.equal(operation.kind, FLEET_STANDARD_LABEL_ACTION);
  assert.equal(operation.payload.repositoryId, "456");
  assert.equal(operation.payload.catalogDigest, catalogDigest);
  assert.deepEqual(operation.payload.labels, catalog.labels);
  assert.equal(operation.idempotencyKey, `sha256:${jsonDigest({
    kind: operation.kind,
    payload: operation.payload,
    repositoryId: "456",
  } as JsonValue)}`);
});

test("readback은 fixed label만 비교하고 custom label 보존을 별도로 검증한다", () => {
  const contract = parseFleetStandardLabelContract({
    config,
    blobSha: config.catalogBlobSha,
    text: JSON.stringify(catalog),
  });
  const operation = fleetStandardLabelOperation({
    contract,
    repositoryId: "456",
    repositoryFullName: "seorilabs/example",
  });
  const drift = normalizeFleetRepositoryLabels({
    operation,
    labels: [
      { name: "P1", color: "ffffff", description: "wrong" },
      { name: "custom", color: "ABCDEF", description: "보존" },
    ],
  });
  assert.equal(drift.observation.state, "DRIFT");
  assert.equal(drift.observation.customLabelCount, 1);

  const match = normalizeFleetRepositoryLabels({
    operation,
    labels: [...catalog.labels, { name: "custom", color: "ABCDEF", description: "보존" }],
  });
  assert.equal(match.observation.state, "MATCH");
  assert.equal(fleetCustomLabelsPreserved(drift.customLabels, match.customLabels), true);
  assert.equal(fleetCustomLabelsPreserved(
    drift.customLabels,
    [{ name: "custom", color: "000000", description: "변경" }],
  ), false);
  assert.throws(() => normalizeFleetRepositoryLabels({
    operation,
    labels: [
      { name: "custom", color: "ABCDEF", description: "a" },
      { name: "CUSTOM", color: "ABCDEF", description: "a" },
    ],
  }), /FLEET_STANDARD_LABEL_READBACK_INVALID/u);
});
