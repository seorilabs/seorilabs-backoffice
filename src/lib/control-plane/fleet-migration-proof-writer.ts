import { Prisma } from "@prisma/client";

import {
  createFleetMigrationBackofficeAdapter,
  fleetMigrationProofDigest,
} from "@/lib/control-plane/fleet-migration-backoffice-adapter";
import {
  fleetMigrationAttestationDigest,
  verifyFleetMigrationPublicAttestation,
} from "@/lib/control-plane/fleet-migration-public-attestation";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";

const CONTRACT = "seorilabs-fleet-migration-proof-write-v1";
const APPROVAL_CONTRACT = "seorilabs-fleet-migration-proof-write-approval-v1";
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/u;
const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const MAX_APPROVAL_TTL_MS = 5 * 60_000;
const PRIVATE_KEY = /^(?:authorization|bytes|cookie|credentialValue|password|privateKey|privateKeyPem|rawSecret|secret|secretValue|token)$/iu;
const PRIVATE_VALUE = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
];
const REQUEST_KEYS = [
  "approvalAttestation",
  "blobInventoryDigest",
  "candidates",
  "contract",
  "createdBy",
  "detections",
  "detectorSourceSha",
  "idempotencyKey",
  "observedAt",
  "readinessCohortDigest",
  "readinessEvidenceDigest",
  "repositoryFullName",
  "repositoryId",
  "sourceRef",
  "sourceSha",
  "stableBackofficeStateDigest",
  "treeSha",
].sort().join(",");
const APPROVAL_PAYLOAD_KEYS = [
  "actor",
  "approvalId",
  "contract",
  "detectorSourceSha",
  "proofDigest",
  "repositoryId",
  "requestHash",
  "schemaVersion",
  "sourceSha",
].sort().join(",");

export interface FleetMigrationProofWriteRequest {
  contract: typeof CONTRACT;
  repositoryId: string;
  repositoryFullName: string;
  sourceRef: string;
  sourceSha: string;
  treeSha: string;
  blobInventoryDigest: string;
  detectorSourceSha: string;
  readinessEvidenceDigest: string;
  readinessCohortDigest: string;
  stableBackofficeStateDigest: string;
  detections: JsonValue[];
  candidates: JsonValue[];
  observedAt: string;
  idempotencyKey: string;
  createdBy: string;
  approvalAttestation: JsonValue;
}

function fail(code: string): never {
  throw new Error(code);
}

function assertSecretFree(value: unknown): void {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === "string") {
      if (PRIVATE_VALUE.some((pattern) => pattern.test(item))) fail("FLEET_MIGRATION_PROOF_PRIVATE_SURFACE_REJECTED");
      return;
    }
    if (item === null || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      if (PRIVATE_KEY.test(key)) fail("FLEET_MIGRATION_PROOF_PRIVATE_SURFACE_REJECTED");
      visit(nested);
    }
  };
  visit(value);
}

function assertRequest(request: FleetMigrationProofWriteRequest): void {
  const observedAt = Date.parse(request.observedAt);
  if (
    Object.keys(request).sort().join(",") !== REQUEST_KEYS
    || request.contract !== CONTRACT
    || !/^[1-9][0-9]{0,31}$/u.test(request.repositoryId)
    || !REPOSITORY.test(request.repositoryFullName)
    || !/^refs\/heads\/[A-Za-z0-9._/-]{1,128}$/u.test(request.sourceRef)
    || !SHA.test(request.sourceSha)
    || !SHA.test(request.treeSha)
    || !DIGEST.test(request.blobInventoryDigest)
    || !SHA.test(request.detectorSourceSha)
    || !SHA256.test(request.readinessEvidenceDigest)
    || !SHA256.test(request.readinessCohortDigest)
    || !SHA256.test(request.stableBackofficeStateDigest)
    || !Array.isArray(request.detections)
    || !Array.isArray(request.candidates)
    || request.detections.length > 10_000
    || request.candidates.length > 10_000
    || !Number.isFinite(observedAt)
    || new Date(observedAt).toISOString() !== request.observedAt
    || !ID.test(request.idempotencyKey)
    || !ID.test(request.createdBy)
  ) fail("FLEET_MIGRATION_PROOF_WRITE_REQUEST_INVALID");
  const publicRequest = { ...request } as Partial<FleetMigrationProofWriteRequest>;
  Reflect.deleteProperty(publicRequest, "approvalAttestation");
  assertSecretFree(publicRequest);
}

function assertCandidatesBound(request: FleetMigrationProofWriteRequest): void {
  const detections = new Map(request.detections.map((entry) => {
    const value = entry as { path?: unknown; contentDigest?: unknown; detection?: unknown; gitEntry?: unknown };
    return [jsonDigest({
      path: value.path as JsonValue,
      contentDigest: value.contentDigest as JsonValue,
      detection: value.detection as JsonValue,
    }), value];
  }));
  if (detections.size !== request.detections.length || request.candidates.length !== request.detections.length) {
    fail("FLEET_MIGRATION_PROOF_CANDIDATE_BINDING_INVALID");
  }
  const seen = new Set<string>();
  for (const candidate of request.candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      fail("FLEET_MIGRATION_PROOF_CANDIDATE_BINDING_INVALID");
    }
    const value = candidate as { path?: unknown; contentDigest?: unknown; detection?: unknown; proofs?: unknown };
    const key = jsonDigest({
      path: value.path as JsonValue,
      contentDigest: value.contentDigest as JsonValue,
      detection: value.detection as JsonValue,
    });
    const detection = detections.get(key);
    if (
      seen.has(key)
      || typeof value.path !== "string"
      || typeof value.contentDigest !== "string"
      || !DIGEST.test(value.contentDigest)
      || !value.proofs
      || typeof value.proofs !== "object"
      || Array.isArray(value.proofs)
      || !detection?.gitEntry
    ) fail("FLEET_MIGRATION_PROOF_CANDIDATE_BINDING_INVALID");
    seen.add(key);
  }
}

export function createFleetMigrationProofWriter(input: {
  publicKey: string | Buffer;
  approvalKeyId: string;
  approvalKeyFingerprint: string;
  approvalPolicyRevision: string;
  snapshotSigningKeyId: string;
  snapshotPolicyRevision: string;
  client?: typeof prisma;
  now?: () => Date;
}) {
  const client = input.client ?? prisma;
  if (
    !ID.test(input.approvalKeyId)
    || !SHA256.test(input.approvalKeyFingerprint)
    || !ID.test(input.approvalPolicyRevision)
    || !ID.test(input.snapshotSigningKeyId)
    || !ID.test(input.snapshotPolicyRevision)
  ) fail("FLEET_MIGRATION_PROOF_WRITER_CONFIGURATION_INVALID");

  return Object.freeze({
    async write(request: FleetMigrationProofWriteRequest) {
      assertRequest(request);
      assertCandidatesBound(request);
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
      const approval = verifyFleetMigrationPublicAttestation({
        value: request.approvalAttestation,
        publicKey: input.publicKey,
        purpose: "PROOF_WRITE_APPROVAL",
        expectedKeyId: input.approvalKeyId,
        expectedKeyFingerprint: input.approvalKeyFingerprint,
        expectedPolicyRevision: input.approvalPolicyRevision,
        maxTtlMs: MAX_APPROVAL_TTL_MS,
        now: input.now?.() ?? new Date(),
      });
      const approvalPayload = approval.payload as Record<string, unknown>;
      if (
        Object.keys(approvalPayload).sort().join(",") !== APPROVAL_PAYLOAD_KEYS
        || approvalPayload.schemaVersion !== 1
        || approvalPayload.contract !== APPROVAL_CONTRACT
        || !ID.test(String(approvalPayload.approvalId ?? ""))
        || approvalPayload.actor !== request.createdBy
        || approvalPayload.proofDigest !== proofDigest
        || approvalPayload.requestHash !== requestHash
        || approvalPayload.repositoryId !== request.repositoryId
        || approvalPayload.sourceSha !== request.sourceSha
        || approvalPayload.detectorSourceSha !== request.detectorSourceSha
      ) fail("FLEET_MIGRATION_PROOF_WRITE_APPROVAL_INVALID");
      const approvalAttestationDigest = fleetMigrationAttestationDigest(approval);

      return client.$transaction(async (transaction) => {
        const stateReader = createFleetMigrationBackofficeAdapter({
          detectorSourceSha: request.detectorSourceSha,
          readinessEvidenceDigest: request.readinessEvidenceDigest,
          readinessCohortDigest: request.readinessCohortDigest,
          snapshotSigningKeyId: input.snapshotSigningKeyId,
          snapshotPolicyRevision: input.snapshotPolicyRevision,
          approvedProofDigests: [],
          client: transaction as never,
          now: input.now,
        });
        const state = await stateReader.readStableBackofficeState({
          contract: "seorilabs-fleet-migration-backoffice-public-evidence-v1",
          organizationId: "283115031",
          repositoryId: request.repositoryId,
          fullName: request.repositoryFullName,
          sourceRef: request.sourceRef,
          sourceSha: request.sourceSha,
          treeSha: request.treeSha,
          blobInventoryDigest: request.blobInventoryDigest,
          detections: request.detections,
        });
        if (state.stableBackofficeStateDigest !== request.stableBackofficeStateDigest) {
          fail("FLEET_MIGRATION_PROOF_BACKOFFICE_STATE_DRIFT");
        }

        const replay = await transaction.fleetMigrationProofSnapshot.findUnique({
          where: { idempotencyKey: request.idempotencyKey },
        });
        if (replay) {
          if (
            replay.requestHash !== requestHash
            || replay.proofDigest !== proofDigest
            || replay.approvalAttestationDigest !== approvalAttestationDigest
          ) fail("FLEET_MIGRATION_PROOF_WRITE_IDEMPOTENCY_CONFLICT");
          return { proofDigest: replay.proofDigest, state: "REPLAY" as const };
        }
        try {
          const created = await transaction.fleetMigrationProofSnapshot.create({
            data: {
              repositoryId: BigInt(request.repositoryId),
              repositoryFullName: request.repositoryFullName,
              sourceSha: request.sourceSha,
              treeSha: request.treeSha,
              blobInventoryDigest: request.blobInventoryDigest,
              detectorSourceSha: request.detectorSourceSha,
              readinessEvidenceDigest: request.readinessEvidenceDigest,
              readinessCohortDigest: request.readinessCohortDigest,
              stableBackofficeStateDigest: request.stableBackofficeStateDigest,
              candidates: request.candidates as Prisma.InputJsonValue,
              candidatesDigest,
              proofDigest,
              approvalId: String(approvalPayload.approvalId),
              approvalAttestation: approval as unknown as Prisma.InputJsonValue,
              approvalAttestationDigest,
              idempotencyKey: request.idempotencyKey,
              requestHash,
              createdBy: request.createdBy,
              observedAt: new Date(request.observedAt),
            },
          });
          return { proofDigest: created.proofDigest, state: "CREATED" as const };
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
          const raced = await transaction.fleetMigrationProofSnapshot.findUnique({
            where: { idempotencyKey: request.idempotencyKey },
          });
          if (
            !raced
            || raced.requestHash !== requestHash
            || raced.proofDigest !== proofDigest
            || raced.approvalAttestationDigest !== approvalAttestationDigest
          ) fail("FLEET_MIGRATION_PROOF_WRITE_IDEMPOTENCY_CONFLICT");
          return { proofDigest: raced.proofDigest, state: "REPLAY" as const };
        }
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 120_000,
      });
    },
  });
}
