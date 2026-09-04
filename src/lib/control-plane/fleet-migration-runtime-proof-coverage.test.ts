import assert from "node:assert/strict";
import test from "node:test";

import { resolveFleetMigrationApprovedProofDigests } from "./fleet-migration-runtime-proof-coverage";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST_A = "c".repeat(64);
const DIGEST_B = "d".repeat(64);

const repositories = [
  { id: "101", fullName: "seorilabs/alpha", sourceSha: SHA_A },
  { id: "202", fullName: "seorilabs/beta", sourceSha: SHA_B },
];

test("runtime proof coverage requires a current approved proof for every exact cohort repository", () => {
  assert.deepEqual(resolveFleetMigrationApprovedProofDigests({
    repositories,
    proofs: [
      { repositoryId: "202", repositoryFullName: "seorilabs/beta", sourceSha: SHA_B, proofDigest: DIGEST_B },
      { repositoryId: "101", repositoryFullName: "seorilabs/alpha", sourceSha: SHA_A, proofDigest: DIGEST_A },
    ],
  }), [DIGEST_A, DIGEST_B]);

  assert.throws(() => resolveFleetMigrationApprovedProofDigests({
    repositories,
    proofs: [
      { repositoryId: "101", repositoryFullName: "seorilabs/alpha", sourceSha: SHA_A, proofDigest: DIGEST_A },
    ],
  }), /FLEET_MIGRATION_RUNTIME_PROOF_COVERAGE_INVALID/u);
});

test("runtime proof coverage rejects source drift and proofs outside the cohort", () => {
  assert.throws(() => resolveFleetMigrationApprovedProofDigests({
    repositories,
    proofs: [
      { repositoryId: "101", repositoryFullName: "seorilabs/alpha", sourceSha: SHA_B, proofDigest: DIGEST_A },
      { repositoryId: "202", repositoryFullName: "seorilabs/beta", sourceSha: SHA_B, proofDigest: DIGEST_B },
    ],
  }), /FLEET_MIGRATION_RUNTIME_PROOF_COVERAGE_INVALID/u);

  assert.throws(() => resolveFleetMigrationApprovedProofDigests({
    repositories,
    proofs: [
      { repositoryId: "101", repositoryFullName: "seorilabs/alpha", sourceSha: SHA_A, proofDigest: DIGEST_A },
      { repositoryId: "202", repositoryFullName: "seorilabs/beta", sourceSha: SHA_B, proofDigest: DIGEST_B },
      { repositoryId: "303", repositoryFullName: "seorilabs/gamma", sourceSha: SHA_A, proofDigest: "e".repeat(64) },
    ],
  }), /FLEET_MIGRATION_RUNTIME_PROOF_COVERAGE_INVALID/u);
});
