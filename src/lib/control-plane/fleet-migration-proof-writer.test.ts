import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  fleetMigrationProofDigest,
  stableFleetMigrationBackofficeStateDigest,
} from "@/lib/control-plane/fleet-migration-backoffice-adapter";
import { createFleetMigrationProofWriter } from "@/lib/control-plane/fleet-migration-proof-writer";
import { signFleetMigrationPublicAttestation } from "@/lib/control-plane/fleet-migration-public-attestation";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const SOURCE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const DETECTOR_SHA = "c".repeat(40);
const READINESS_DIGEST = "d".repeat(64);
const COHORT_DIGEST = "e".repeat(64);
const BLOB_DIGEST = `sha256:${"f".repeat(64)}`;
const APPROVAL_KEY_ID = "fleet-proof-approval-v1";
const APPROVAL_POLICY = "fleet-proof-policy-v1";
const CREATED_BY = "trusted-operator";
const STABLE_DIGEST = stableFleetMigrationBackofficeStateDigest({
  classification: "INFRA_REPO",
  classificationDecisionRevision: 1,
  classificationDecisionId: "classification-decision-0001",
  app: null,
  activeConfig: null,
  signedSnapshot: null,
  platformFleetBinding: null,
  providerObservations: [],
  credentialBindings: [],
});

function keyFingerprint(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  return createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
}

function fakeClient() {
  const rows = new Map<string, Record<string, unknown>>();
  const proofModel = {
    async findUnique(input: { where: { idempotencyKey: string } }) {
      return rows.get(input.where.idempotencyKey) ?? null;
    },
    async create(input: { data: Record<string, unknown> }) {
      if (rows.has(String(input.data.idempotencyKey))) throw new Error("duplicate");
      const row = { id: "proof-snapshot-0001", ...input.data };
      rows.set(String(input.data.idempotencyKey), row);
      return row;
    },
  };
  const transaction = {
    repositoryRegistration: {
      async findUnique(input: { where: { repoFullName?: string } }) {
        if (input.where.repoFullName === "seorilabs/platform") return { repoId: 999n };
        return {
          repoId: 101n,
          repoFullName: "seorilabs/infra",
          defaultBranch: "main",
          classification: "INFRA_REPO",
          classificationDecisionVersion: 1,
          classificationDecisions: [{ id: "classification-decision-0001", revision: 1, classification: "INFRA_REPO" }],
        };
      },
    },
    app: { async findUnique() { return null; } },
    fleetMigrationProofSnapshot: proofModel,
  };
  return {
    ...transaction,
    async $transaction<Result>(execute: (client: typeof transaction) => Promise<Result>) {
      return execute(transaction);
    },
    rows,
  };
}

function unsignedRequest() {
  const candidates: [] = [];
  return {
    contract: "seorilabs-fleet-migration-proof-write-v1" as const,
    repositoryId: "101",
    repositoryFullName: "seorilabs/infra",
    sourceRef: "refs/heads/main",
    sourceSha: SOURCE_SHA,
    treeSha: TREE_SHA,
    blobInventoryDigest: BLOB_DIGEST,
    detectorSourceSha: DETECTOR_SHA,
    readinessEvidenceDigest: READINESS_DIGEST,
    readinessCohortDigest: COHORT_DIGEST,
    stableBackofficeStateDigest: STABLE_DIGEST,
    detections: [],
    candidates,
    observedAt: NOW.toISOString(),
    idempotencyKey: "proof-idempotency-0001",
    createdBy: CREATED_BY,
  };
}

function approvedRequest(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  overrides: Partial<ReturnType<typeof unsignedRequest>> = {},
) {
  const request = { ...unsignedRequest(), ...overrides };
  const candidatesDigest = `sha256:${jsonDigest(request.candidates)}`;
  const proofDigest = fleetMigrationProofDigest({
    repositoryId: request.repositoryId,
    repositoryFullName: request.repositoryFullName,
    sourceSha: request.sourceSha,
    treeSha: request.treeSha,
    blobInventoryDigest: request.blobInventoryDigest,
    detectorSourceSha: request.detectorSourceSha,
    readinessEvidenceDigest: request.readinessEvidenceDigest,
    readinessCohortDigest: request.readinessCohortDigest,
    stableBackofficeStateDigest: request.stableBackofficeStateDigest,
    candidatesDigest,
  });
  const requestHash = jsonDigest({
    contract: request.contract,
    createdBy: request.createdBy,
    idempotencyKey: request.idempotencyKey,
    observedAt: request.observedAt,
    proofDigest,
  });
  const approvalAttestation = signFleetMigrationPublicAttestation({
    privateKey,
    purpose: "PROOF_WRITE_APPROVAL",
    keyId: APPROVAL_KEY_ID,
    policyRevision: APPROVAL_POLICY,
    issuedAt: new Date(NOW.getTime() - 1_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    nonce: "proof-approval-nonce-0001",
    payload: {
      schemaVersion: 1,
      contract: "seorilabs-fleet-migration-proof-write-approval-v1",
      approvalId: "proof-approval-0001",
      actor: request.createdBy,
      proofDigest,
      requestHash,
      repositoryId: request.repositoryId,
      sourceSha: request.sourceSha,
      detectorSourceSha: request.detectorSourceSha,
    },
  });
  return { ...request, approvalAttestation: approvalAttestation as unknown as JsonValue, proofDigest };
}

test("proof writer revalidates stable state and inserts an approved idempotent snapshot exactly once", async () => {
  const keys = generateKeyPairSync("ed25519");
  const fixture = fakeClient();
  const writer = createFleetMigrationProofWriter({
    publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
    approvalKeyId: APPROVAL_KEY_ID,
    approvalKeyFingerprint: keyFingerprint(keys.publicKey),
    approvalPolicyRevision: APPROVAL_POLICY,
    snapshotSigningKeyId: "control-plane-snapshot-v1",
    snapshotPolicyRevision: "snapshot-policy-v1",
    client: fixture as never,
    now: () => NOW,
  });
  const approved = approvedRequest(keys.privateKey);
  const { proofDigest, ...request } = approved;
  const created = await writer.write(request);
  const replay = await writer.write(request);
  assert.deepEqual(created, { proofDigest, state: "CREATED" });
  assert.deepEqual(replay, { proofDigest, state: "REPLAY" });
  assert.equal(fixture.rows.size, 1);
  assert.equal(fixture.rows.get(request.idempotencyKey)?.createdBy, CREATED_BY);
});

test("proof writer rejects a stale Backoffice digest before INSERT", async () => {
  const keys = generateKeyPairSync("ed25519");
  const fixture = fakeClient();
  const writer = createFleetMigrationProofWriter({
    publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
    approvalKeyId: APPROVAL_KEY_ID,
    approvalKeyFingerprint: keyFingerprint(keys.publicKey),
    approvalPolicyRevision: APPROVAL_POLICY,
    snapshotSigningKeyId: "control-plane-snapshot-v1",
    snapshotPolicyRevision: "snapshot-policy-v1",
    client: fixture as never,
    now: () => NOW,
  });
  const stale = approvedRequest(keys.privateKey, {
    stableBackofficeStateDigest: "0".repeat(64),
  });
  Reflect.deleteProperty(stale, "proofDigest");
  await assert.rejects(writer.write(stale), /FLEET_MIGRATION_PROOF_BACKOFFICE_STATE_DRIFT/);
  assert.equal(fixture.rows.size, 0);
});
