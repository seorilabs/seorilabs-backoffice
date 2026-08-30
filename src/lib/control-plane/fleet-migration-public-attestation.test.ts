import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  signFleetMigrationPublicAttestation,
  verifyFleetMigrationPublicAttestation,
} from "@/lib/control-plane/fleet-migration-public-attestation";
import { loadFleetMigrationRuntimeCapability } from "@/lib/control-plane/fleet-migration-runtime-capability";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const KEY_ID = "fleet-runtime-key-v1";
const POLICY = "fleet-runtime-policy-v1";

function signingFixture() {
  const keys = generateKeyPairSync("ed25519");
  const payload = { schemaVersion: 1, contract: "public-fixture-v1", state: "READY" };
  const attestation = signFleetMigrationPublicAttestation({
    privateKey: keys.privateKey,
    purpose: "SHADOW_RUNTIME",
    keyId: KEY_ID,
    policyRevision: POLICY,
    issuedAt: new Date(NOW.getTime() - 1_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    nonce: "runtime-nonce-0001",
    payload,
  });
  return { ...keys, payload, attestation };
}

test("public Ed25519 attestation verifies exact purpose, policy, payload and TTL", () => {
  const fixture = signingFixture();
  const verified = verifyFleetMigrationPublicAttestation({
    value: fixture.attestation,
    publicKey: fixture.publicKey,
    purpose: "SHADOW_RUNTIME",
    expectedKeyId: KEY_ID,
    expectedKeyFingerprint: fixture.attestation.keyFingerprint,
    expectedPolicyRevision: POLICY,
    maxTtlMs: 65_000,
    now: NOW,
  });
  assert.deepEqual(verified.payload, fixture.payload);
  assert.throws(() => verifyFleetMigrationPublicAttestation({
    value: fixture.attestation,
    publicKey: fixture.publicKey,
    purpose: "SHADOW_RUNTIME",
    expectedKeyId: KEY_ID,
    expectedKeyFingerprint: "0".repeat(64),
    expectedPolicyRevision: POLICY,
    maxTtlMs: 65_000,
    now: NOW,
  }), /FLEET_MIGRATION_PUBLIC_ATTESTATION_INVALID/);
  assert.throws(() => verifyFleetMigrationPublicAttestation({
    value: fixture.attestation,
    publicKey: fixture.publicKey,
    purpose: "PROOF_WRITE_APPROVAL",
    expectedKeyId: KEY_ID,
    expectedKeyFingerprint: fixture.attestation.keyFingerprint,
    expectedPolicyRevision: POLICY,
    maxTtlMs: 65_000,
    now: NOW,
  }), /FLEET_MIGRATION_PUBLIC_ATTESTATION_INVALID/);
  assert.throws(() => verifyFleetMigrationPublicAttestation({
    value: { ...fixture.attestation, payload: { ...fixture.payload, state: "DRIFT" } },
    publicKey: fixture.publicKey,
    purpose: "SHADOW_RUNTIME",
    expectedKeyId: KEY_ID,
    expectedKeyFingerprint: fixture.attestation.keyFingerprint,
    expectedPolicyRevision: POLICY,
    maxTtlMs: 65_000,
    now: NOW,
  }), /FLEET_MIGRATION_PUBLIC_ATTESTATION_INVALID/);
  assert.throws(() => verifyFleetMigrationPublicAttestation({
    value: fixture.attestation,
    publicKey: fixture.publicKey,
    purpose: "SHADOW_RUNTIME",
    expectedKeyId: KEY_ID,
    expectedKeyFingerprint: fixture.attestation.keyFingerprint,
    expectedPolicyRevision: POLICY,
    maxTtlMs: 65_000,
    now: new Date(NOW.getTime() + 120_000),
  }), /FLEET_MIGRATION_PUBLIC_ATTESTATION_EXPIRED/);
});

async function projectedRuntimeFixture(tokenOverride?: string) {
  const token = tokenOverride ?? "github-read-capability-value-0000000001";
  const keys = generateKeyPairSync("ed25519");
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-runtime-projected-")));
  const revision = join(root, "..2026_08_30_00_00_00.000000001");
  await mkdir(revision, { mode: 0o700 });
  const sourceSha = "a".repeat(40);
  const detectorSha = "b".repeat(40);
  const executionId = "fleet-execution-0001";
  const payload = {
    schemaVersion: 1,
    contract: "seorilabs-fleet-migration-shadow-runtime-capability-v1",
    executionId,
    organizationId: "283115031",
    installationId: "142120077",
    backofficeSourceSha: sourceSha,
    detectorSourceSha: detectorSha,
    readinessEvidenceDigest: "c".repeat(64),
    readinessCohortDigest: "d".repeat(64),
    snapshotSigningKeyId: "control-plane-snapshot-v1",
    snapshotPolicyRevision: "snapshot-policy-v1",
    approvedProofDigests: ["e".repeat(64)],
    github: {
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      tokenExpiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
      permissions: { contents: "read", metadata: "read" },
      repositories: [{ id: "101", fullName: "seorilabs/example" }],
      publicSource: {
        observedAt: new Date(NOW.getTime() - 2_000).toISOString(),
        app: {
          id: "4124446",
          slug: "seorilabs-backoffice",
          ownerId: "283115031",
          ownerLogin: "seorilabs",
          active: true,
          webhookActive: true,
          webhookUrl: "https://backoffice.seorilabs.com/api/github/webhook",
          permissions: { contents: "write", metadata: "read" },
          events: ["repository"],
        },
        installation: {
          appId: "4124446",
          installationId: "142120077",
          targetId: "283115031",
          targetType: "Organization",
          accountLogin: "seorilabs",
          repositorySelection: "all",
          suspended: false,
          permissions: { contents: "write", metadata: "read" },
          events: ["repository"],
          updatedAt: new Date(NOW.getTime() - 2_000).toISOString(),
          suspendedAt: null,
        },
      },
      webhookAcceptance: {
        deliveryId: "github-delivery-0001",
        acceptedAt: new Date(NOW.getTime() - 2_000).toISOString(),
      },
    },
    configSnapshots: [],
  };
  const attestation = signFleetMigrationPublicAttestation({
    privateKey: keys.privateKey,
    purpose: "SHADOW_RUNTIME",
    keyId: KEY_ID,
    policyRevision: POLICY,
    issuedAt: new Date(NOW.getTime() - 1_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 31 * 60_000).toISOString(),
    nonce: "runtime-nonce-0002",
    payload: payload as never,
  });
  const files = {
    "runtime-attestation.json": JSON.stringify(attestation),
    "runtime-attestation-public.pem": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    "installation.token": token,
  };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(revision, name), value, { mode: 0o440 });
  }
  await symlink(revision.split("/").at(-1)!, join(root, "..data"));
  for (const name of Object.keys(files)) await symlink(join("..data", name), join(root, name));
  return { root, sourceSha, detectorSha, executionId, keyFingerprint: attestation.keyFingerprint };
}

test("runtime capability binds projected token to signed exact cohort, source and read-only permissions", async () => {
  const fixture = await projectedRuntimeFixture();
  let revokeCalls = 0;
  const runtime = await loadFleetMigrationRuntimeCapability({
    attestationRoot: fixture.root,
    attestationFile: "runtime-attestation.json",
    publicKeyRoot: fixture.root,
    publicKeyFile: "runtime-attestation-public.pem",
    tokenRoot: fixture.root,
    tokenFile: "installation.token",
    expectedExecutionId: fixture.executionId,
    expectedBackofficeSourceSha: fixture.sourceSha,
    expectedDetectorSourceSha: fixture.detectorSha,
    expectedKeyId: KEY_ID,
    expectedKeyFingerprint: fixture.keyFingerprint,
    expectedPolicyRevision: POLICY,
    now: () => NOW,
    createClient: () => ({ request: async (route: string) => {
      assert.equal(route, "DELETE /installation/token");
      revokeCalls += 1;
      return {};
    } }) as never,
  });
  assert.deepEqual(runtime.payload.github.permissions, { contents: "read", metadata: "read" });
  assert.deepEqual(runtime.payload.github.repositories, [{ id: "101", fullName: "seorilabs/example" }]);
  assert.match(runtime.publicAttestationDigest, /^[0-9a-f]{64}$/u);
  assert.match(runtime.cohortDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(await runtime.run(async () => "complete"), "complete");
  assert.equal(revokeCalls, 1);
  await assert.rejects(runtime.run(async () => "unexpected"), /FLEET_MIGRATION_RUNTIME_CAPABILITY_ALREADY_CONSUMED/);
});

test("runtime capability rejects a token whose bytes are not covered by the public attestation", async () => {
  const fixture = await projectedRuntimeFixture();
  const tokenFile = join(fixture.root, "..2026_08_30_00_00_00.000000001", "installation.token");
  await chmod(tokenFile, 0o600);
  await writeFile(tokenFile, "different-github-read-capability-000000001");
  await chmod(tokenFile, 0o440);
  await assert.rejects(loadFleetMigrationRuntimeCapability({
    attestationRoot: fixture.root,
    attestationFile: "runtime-attestation.json",
    publicKeyRoot: fixture.root,
    publicKeyFile: "runtime-attestation-public.pem",
    tokenRoot: fixture.root,
    tokenFile: "installation.token",
    expectedExecutionId: fixture.executionId,
    expectedBackofficeSourceSha: fixture.sourceSha,
    expectedDetectorSourceSha: fixture.detectorSha,
    expectedKeyId: KEY_ID,
    expectedKeyFingerprint: fixture.keyFingerprint,
    expectedPolicyRevision: POLICY,
    now: () => NOW,
    createClient: () => ({ request: async () => ({}) }) as never,
  }), /FLEET_MIGRATION_RUNTIME_CAPABILITY_BINDING_INVALID/);
});
