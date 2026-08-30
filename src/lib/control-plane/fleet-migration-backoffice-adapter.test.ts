import assert from "node:assert/strict";
import test from "node:test";

import { createFleetMigrationBackofficeAdapter } from "@/lib/control-plane/fleet-migration-backoffice-adapter";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const SOURCE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const DETECTOR_SHA = "c".repeat(40);
const BLOB_INVENTORY_DIGEST = `sha256:${"d".repeat(64)}`;
const READINESS_DIGEST = "e".repeat(64);

function fixtureClient(proofPresent = true) {
  const candidates: JsonValue[] = [];
  const registration = {
    repoId: 101n,
    repoFullName: "seorilabs/infra",
    defaultBranch: "main",
    classification: "INFRA_REPO",
    classificationDecisionVersion: 7,
    classificationDecisions: [{ id: "classification-decision-0001", revision: 7, classification: "INFRA_REPO" }],
  };
  return {
    repositoryRegistration: {
      async findUnique(input: { where: { repoId?: bigint; repoFullName?: string } }) {
        return input.where.repoFullName === "seorilabs/platform" ? { repoId: 999n } : registration;
      },
    },
    app: { async findUnique() { return null; } },
    fleetMigrationProofSnapshot: {
      async findUnique() {
        return proofPresent ? {
          id: "proof-snapshot-0001",
          repositoryId: 101n,
          repositoryFullName: "seorilabs/infra",
          sourceSha: SOURCE_SHA,
          treeSha: TREE_SHA,
          blobInventoryDigest: BLOB_INVENTORY_DIGEST,
          detectorSourceSha: DETECTOR_SHA,
          readinessEvidenceDigest: READINESS_DIGEST,
          candidates,
          candidatesDigest: `sha256:${jsonDigest(candidates)}`,
          observedAt: new Date("2026-08-30T00:00:00.000Z"),
          createdAt: new Date("2026-08-30T00:00:00.000Z"),
        } : null;
      },
    },
  };
}

function request() {
  return {
    contract: "seorilabs-fleet-migration-backoffice-public-evidence-v1",
    organizationId: "283115031",
    repositoryId: "101",
    fullName: "seorilabs/infra",
    sourceRef: "refs/heads/main",
    sourceSha: SOURCE_SHA,
    treeSha: TREE_SHA,
    blobInventoryDigest: BLOB_INVENTORY_DIGEST,
    detections: [],
  };
}

test("Backoffice adapter returns only public exact-source evidence from an immutable proof snapshot", async () => {
  const adapter = createFleetMigrationBackofficeAdapter({
    detectorSourceSha: DETECTOR_SHA,
    readinessEvidenceDigest: READINESS_DIGEST,
    snapshotSigningKeyId: "control-plane-snapshot-v1",
    snapshotPolicyRevision: "snapshot-policy-v1",
    client: fixtureClient() as never,
    now: () => new Date("2026-08-30T00:00:01.000Z"),
  });
  const result = await adapter.readBackofficePublicEvidence(request());
  assert.equal(result.publicEvidence.repositoryId, "101");
  assert.equal(result.publicEvidence.sourceSha, SOURCE_SHA);
  assert.equal(result.publicEvidence.classification, "INFRA_REPO");
  assert.deepEqual(result.candidates, []);
  assert.doesNotMatch(JSON.stringify(result), /payload|token|secretValue|privateKey/iu);
});

test("missing or stale proof snapshot fails closed instead of inferring a replacement", async () => {
  const adapter = createFleetMigrationBackofficeAdapter({
    detectorSourceSha: DETECTOR_SHA,
    readinessEvidenceDigest: READINESS_DIGEST,
    snapshotSigningKeyId: "control-plane-snapshot-v1",
    snapshotPolicyRevision: "snapshot-policy-v1",
    client: fixtureClient(false) as never,
  });
  await assert.rejects(
    adapter.readBackofficePublicEvidence(request()),
    /FLEET_MIGRATION_PROOF_SNAPSHOT_MISSING_OR_STALE/,
  );
});
