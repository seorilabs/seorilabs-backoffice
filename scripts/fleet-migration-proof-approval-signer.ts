/**
 * P7 proof write approval signer — trusted approval service의 서명 단계다.
 *
 * `fleet-migration-proof-request-builder`가 모은 수집 결과를 받아 저장소마다
 * 5분 Ed25519 `PROOF_WRITE_APPROVAL`을 서명하고, proof writer Job이 ConfigMap으로
 * 받을 `proof-write-request.json`을 만든다.
 *
 * trusted operator 로컬에서만 돈다. private key는 파일 경로가 아니라 fd로만 받고,
 * 클러스터에는 공개키와 서명된 승인문만 올라간다. 승인은 5분 만료라 이 스크립트의
 * 산출물은 즉시 소비해야 한다.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  fleetMigrationProofDigest,
} from "@/lib/control-plane/fleet-migration-backoffice-adapter";
import {
  signFleetMigrationPublicAttestation,
} from "@/lib/control-plane/fleet-migration-public-attestation";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const CONTRACT = "seorilabs-fleet-migration-proof-write-v1";
const APPROVAL_CONTRACT = "seorilabs-fleet-migration-proof-write-approval-v1";
const APPROVAL_TTL_MS = 4 * 60_000;
const SHA = /^[0-9a-f]{40}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/u;

type CollectedRequest = {
  repositoryId: string;
  repositoryFullName: string;
  sourceRef: string;
  sourceSha: string;
  treeSha: string;
  blobInventoryDigest: string;
  detections: JsonValue[];
  candidates: JsonValue[];
  stableBackofficeStateDigest: string;
};

function required(name: string, pattern: RegExp): string {
  const value = process.env[name]?.trim() ?? "";
  if (!pattern.test(value)) throw new Error(`FLEET_MIGRATION_${name}_INVALID`);
  return value;
}

function parseFd(name: string): number {
  const raw = process.env[name]?.trim() ?? "";
  const fd = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(fd) || fd < 3 || String(fd) !== raw) {
    throw new Error(`FLEET_MIGRATION_${name}_INVALID`);
  }
  return fd;
}

function main(): void {
  const collectionPath = required("FLEET_MIGRATION_COLLECTION_FILE", /^\/?[\w./-]{1,512}$/u);
  const actor = required("FLEET_MIGRATION_APPROVAL_ACTOR", ID);
  const keyId = required("FLEET_MIGRATION_APPROVAL_KEY_ID", ID);
  const policyRevision = required("FLEET_MIGRATION_APPROVAL_POLICY_REVISION", ID);
  const only = process.env.FLEET_MIGRATION_APPROVAL_REPOSITORY_ID?.trim() ?? "";

  const collection = JSON.parse(readFileSync(collectionPath, "utf8")) as {
    contract: string;
    detectorSourceSha: string;
    readinessEvidenceDigest: string;
    readinessCohortDigest: string;
    requests: CollectedRequest[];
  };
  if (
    collection.contract !== "seorilabs-fleet-migration-proof-request-collection-v1"
    || !SHA.test(collection.detectorSourceSha)
    || !Array.isArray(collection.requests)
    || collection.requests.length < 1
  ) throw new Error("FLEET_MIGRATION_PROOF_COLLECTION_INVALID");

  // 승인은 5분 만료다. 한 번에 전부 서명하면 뒤쪽 저장소는 Job이 도는 사이 만료된다.
  // 그래서 기본은 저장소 하나씩 서명하고, 호출자가 서명 직후 바로 소비한다.
  const targets = only.length > 0
    ? collection.requests.filter((request) => request.repositoryId === only)
    : collection.requests;
  if (targets.length !== 1) throw new Error("FLEET_MIGRATION_PROOF_APPROVAL_TARGET_INVALID");

  const privateKeyFd = parseFd("FLEET_MIGRATION_APPROVAL_PRIVATE_KEY_FD");
  let privateKey: Buffer | undefined;
  try {
    privateKey = readFileSync(privateKeyFd);
    const target = targets[0]!;
    const observedAt = new Date().toISOString();
    const candidatesDigest = `sha256:${jsonDigest(target.candidates)}`;
    const proofDigest = fleetMigrationProofDigest({
      repositoryId: target.repositoryId,
      repositoryFullName: target.repositoryFullName,
      sourceSha: target.sourceSha,
      treeSha: target.treeSha,
      blobInventoryDigest: target.blobInventoryDigest,
      detectorSourceSha: collection.detectorSourceSha,
      readinessEvidenceDigest: collection.readinessEvidenceDigest,
      readinessCohortDigest: collection.readinessCohortDigest,
      stableBackofficeStateDigest: target.stableBackofficeStateDigest,
      candidatesDigest,
    });
    // 멱등성 키는 요청 전체에 결박해야 한다. repositoryId + sourceSha만 쓰면 sha가
    // 그대로인 채 readiness digest·detector SHA·stable Backoffice state가 바뀌어 새
    // proof가 필요할 때도 같은 키가 나오고, writer가 IDEMPOTENCY_CONFLICT로 거부해
    // 그 저장소는 commit을 억지로 움직이지 않는 한 proof를 얻을 수 없다.
    //
    // proofDigest는 그 값들을 모두 덮으므로(`fleet-migration-backoffice-adapter.ts:233`)
    // 상태가 바뀌면 키도 바뀐다. 반대로 같은 상태를 다시 서명하면 키는 같고 attestation
    // nonce만 달라 conflict가 나는데, 그건 이미 그 상태의 proof가 있다는 뜻이라 안전한
    // 실패다. 발급기는 기존 proof로 이미 충족된다.
    const idempotencyKey = `fleet-proof-${proofDigest.slice(0, 40)}`;
    if (!ID.test(idempotencyKey)) throw new Error("FLEET_MIGRATION_PROOF_IDEMPOTENCY_KEY_INVALID");
    // writer가 같은 식으로 다시 계산해 승인문과 대조한다
    // (`fleet-migration-proof-writer.ts:205-211`).
    const requestHash = jsonDigest({
      contract: CONTRACT,
      createdBy: actor,
      idempotencyKey,
      observedAt,
      proofDigest,
    });
    const issuedAt = new Date();
    const approvalAttestation = signFleetMigrationPublicAttestation({
      privateKey,
      purpose: "PROOF_WRITE_APPROVAL",
      keyId,
      policyRevision,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + APPROVAL_TTL_MS).toISOString(),
      nonce: randomUUID(),
      payload: {
        actor,
        approvalId: `fleet-proof-approval-${randomUUID()}`,
        contract: APPROVAL_CONTRACT,
        detectorSourceSha: collection.detectorSourceSha,
        proofDigest,
        repositoryId: target.repositoryId,
        requestHash,
        schemaVersion: 1,
        sourceSha: target.sourceSha,
      },
    });

    process.stdout.write(`${JSON.stringify({
      contract: CONTRACT,
      repositoryId: target.repositoryId,
      repositoryFullName: target.repositoryFullName,
      sourceRef: target.sourceRef,
      sourceSha: target.sourceSha,
      treeSha: target.treeSha,
      blobInventoryDigest: target.blobInventoryDigest,
      detectorSourceSha: collection.detectorSourceSha,
      readinessEvidenceDigest: collection.readinessEvidenceDigest,
      readinessCohortDigest: collection.readinessCohortDigest,
      stableBackofficeStateDigest: target.stableBackofficeStateDigest,
      detections: target.detections,
      candidates: target.candidates,
      observedAt,
      idempotencyKey,
      createdBy: actor,
      approvalAttestation,
    })}\n`);
  } finally {
    privateKey?.fill(0);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  console.error(`Fleet migration proof approval signer 실패: ${
    /^FLEET_MIGRATION_[A-Z0-9_]+$/u.test(message) ? message : "FLEET_MIGRATION_PROOF_APPROVAL_FAILED"
  }`);
  process.exitCode = 1;
}
