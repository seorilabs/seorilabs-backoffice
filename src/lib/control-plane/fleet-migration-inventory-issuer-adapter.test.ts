import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { fleetMigrationInventoryIssuerContract } from "@seorilabs/repo-contract/trusted-inventory-issuer";

import {
  createFleetMigrationInventoryIssuerAdapters,
  loadFleetMigrationInventoryPublicIdentity,
} from "@/lib/control-plane/fleet-migration-inventory-issuer-adapter";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

async function publicIdentityFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "fleet-inventory-public-")));
  const { publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ format: "pem", type: "spki" });
  const der = publicKey.export({ format: "der", type: "spki" });
  const fingerprint = `sha256:${createHash("sha256").update(der).digest("hex")}`;
  const publicKeyFile = join(directory, "inventory-public.pem");
  const publicCatalogFile = join(directory, "inventory-public.json");
  await writeFile(publicKeyFile, pem, { mode: 0o400 });
  await writeFile(publicCatalogFile, JSON.stringify({
    schemaVersion: 1,
    credentialId: fleetMigrationInventoryIssuerContract.signingCredentialId,
    keyId: fleetMigrationInventoryIssuerContract.keyId,
    keyPurpose: fleetMigrationInventoryIssuerContract.keyPurpose,
    algorithm: "Ed25519",
    keyFingerprint: fingerprint,
    state: "ACTIVE",
    revision: "catalog-revision-0001",
  }), { mode: 0o400 });
  await chmod(directory, 0o700);
  return { directory, publicKeyFile, publicCatalogFile, fingerprint };
}

function signingRequest(payload: Buffer) {
  return {
    algorithm: "Ed25519",
    credentialId: fleetMigrationInventoryIssuerContract.signingCredentialId,
    keyId: fleetMigrationInventoryIssuerContract.keyId,
    keyPurpose: fleetMigrationInventoryIssuerContract.keyPurpose,
    policyRevision: "inventory-policy-v1",
    signedAt: "2026-08-30T00:00:00.000Z",
    inventoryId: "fleet-bootstrap-fixture",
    inventoryDigest: DIGEST_A,
    collectionCapabilityEvidenceDigest: DIGEST_B,
    issuanceCapabilityEvidenceDigest: DIGEST_C,
    collectionDigest: DIGEST_A,
    payloadDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
    payload,
  };
}

test("public catalog and exact Ed25519 SPKI fingerprint are read without private key input", async () => {
  const fixture = await publicIdentityFixture();
  const identity = await loadFleetMigrationInventoryPublicIdentity(fixture);
  assert.equal(identity.publicKey.type, "public");
  assert.equal(identity.publicKey.asymmetricKeyType, "ed25519");
  assert.equal(identity.catalog.keyFingerprint, fixture.fingerprint);

  const link = join(fixture.directory, "public-link.pem");
  await symlink(fixture.publicKeyFile, link);
  await assert.rejects(
    loadFleetMigrationInventoryPublicIdentity({ ...fixture, publicKeyFile: link }),
    /FLEET_MIGRATION_PUBLIC_METADATA_PATH_INVALID/,
  );
});

test("signing adapter forwards only the exact public contract and rejects secret-shaped extras", async () => {
  const fixture = await publicIdentityFixture();
  const identity = await loadFleetMigrationInventoryPublicIdentity(fixture);
  let calls = 0;
  const adapter = createFleetMigrationInventoryIssuerAdapters({
    catalog: identity.catalog,
    signingTransport: async (request) => {
      calls += 1;
      assert.deepEqual(Object.keys(request).sort(), [
        "algorithm",
        "collectionCapabilityEvidenceDigest",
        "collectionDigest",
        "credentialId",
        "inventoryDigest",
        "inventoryId",
        "issuanceCapabilityEvidenceDigest",
        "keyId",
        "keyPurpose",
        "payload",
        "payloadDigest",
        "policyRevision",
        "signedAt",
      ]);
      return {
        algorithm: "Ed25519",
        credentialId: identity.catalog.credentialId,
        keyFingerprint: identity.catalog.keyFingerprint,
        keyId: identity.catalog.keyId,
        value: "A".repeat(86),
      };
    },
  });
  const payload = Buffer.from("public canonical inventory payload", "utf8");
  const result = await adapter.signInventoryPayload(signingRequest(payload));
  assert.equal(result.value, "A".repeat(86));
  assert.equal(calls, 1);

  await assert.rejects(
    adapter.signInventoryPayload({ ...signingRequest(payload), secretValue: "must-not-cross-boundary" }),
    /FLEET_MIGRATION_INVENTORY_SIGNING_REQUEST_INVALID/,
  );
  assert.equal(calls, 1);
});

test("signing response with any undeclared field is rejected", async () => {
  const fixture = await publicIdentityFixture();
  const identity = await loadFleetMigrationInventoryPublicIdentity(fixture);
  const adapter = createFleetMigrationInventoryIssuerAdapters({
    catalog: identity.catalog,
    signingTransport: async () => ({
      algorithm: "Ed25519",
      credentialId: identity.catalog.credentialId,
      keyFingerprint: identity.catalog.keyFingerprint,
      keyId: identity.catalog.keyId,
      value: "A".repeat(86),
      secretValue: "unexpected",
    }),
  });
  await assert.rejects(
    adapter.signInventoryPayload(signingRequest(Buffer.from("payload", "utf8"))),
    /FLEET_MIGRATION_INVENTORY_SIGNING_RESPONSE_INVALID/,
  );
});
