import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createFleetMigrationAuthoritativeIssuanceStore } from "@/lib/control-plane/fleet-migration-authoritative-issuance";

const NOW = new Date("2026-08-31T08:00:00.000Z");
const INVENTORY_DIGEST = `sha256:${"1".repeat(64)}`;
const ISSUANCE_DIGEST = `sha256:${"2".repeat(64)}`;
const PROVIDER_DIGEST = `sha256:${"3".repeat(64)}`;
const KEY_FINGERPRINT = `sha256:${"4".repeat(64)}`;
const IDENTITY = {
  occurrenceId: "fleet-occurrence-0001",
  runId: "fleet-run-0001",
  providerVectorDigest: PROVIDER_DIGEST,
};
const { publicKey } = generateKeyPairSync("ed25519");

function issuance(extra: Record<string, unknown> = {}) {
  return {
    contract: "seorilabs-fleet-migration-authoritative-inventory-v1",
    state: "READY",
    authoritative: true,
    readyForPlanning: true,
    inventoryDigest: INVENTORY_DIGEST,
    issuanceDigest: ISSUANCE_DIGEST,
    keyFingerprint: KEY_FINGERPRINT,
    inventory: {
      inventoryId: "fleet-inventory-0001",
      expiresAt: "2026-08-31T08:14:00.000Z",
      attestation: { signedAt: "2026-08-31T08:00:00.000Z" },
    },
    ...extra,
  };
}

function memoryClient() {
  let row: Record<string, unknown> | null = null;
  const completion = {
    occurrenceId: IDENTITY.occurrenceId,
    runId: IDENTITY.runId,
    providerVectorDigest: IDENTITY.providerVectorDigest,
    inventoryDigest: INVENTORY_DIGEST,
  };
  return {
    client: {
      fleetMigrationCollectionCompletion: {
        findUnique: async () => completion,
      },
      fleetMigrationAuthoritativeIssuance: {
        findUnique: async ({ where }: { where: Record<string, unknown> }) => {
          if (!row) return null;
          if (where.occurrenceId === row.occurrenceId || where.issuanceDigest === row.issuanceDigest) {
            return row;
          }
          return null;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          row = {
            id: "fleet-issuance-row-0001",
            createdAt: NOW,
            ...structuredClone(data),
          };
          return row;
        },
      },
    },
    drift(field: string, value: unknown) {
      assert.ok(row);
      row[field] = value;
    },
  };
}

function trustedValidator() {
  return { ok: true, diagnostics: [] };
}

test("authoritative issuance는 completion에 결합해 한 번 보존하고 exact replay한다", async () => {
  const memory = memoryClient();
  const store = createFleetMigrationAuthoritativeIssuanceStore(memory.client as never, {
    validateAuthoritative: trustedValidator,
  });
  const first = await store.preserve({
    ...IDENTITY,
    issuance: issuance(),
    publicKey,
    now: NOW,
  });
  assert.equal(first.state, "PRESERVED");
  assert.equal(first.issuance.issuanceDigest, ISSUANCE_DIGEST);

  const replay = await store.preserve({
    ...IDENTITY,
    issuance: issuance(),
    publicKey,
    now: NOW,
  });
  assert.equal(replay.state, "REPLAYED");
  assert.deepEqual(replay.issuance, first.issuance);

  const readback = await store.readExact({
    ...IDENTITY,
    issuanceDigest: ISSUANCE_DIGEST,
    publicKey,
    now: NOW,
  });
  assert.deepEqual(readback, first.issuance);
});

test("completion digest, durable row drift, private surface를 fail-closed한다", async () => {
  const memory = memoryClient();
  const store = createFleetMigrationAuthoritativeIssuanceStore(memory.client as never, {
    validateAuthoritative: trustedValidator,
  });
  await store.preserve({
    ...IDENTITY,
    issuance: issuance(),
    publicKey,
    now: NOW,
  });
  memory.drift("keyFingerprint", `sha256:${"9".repeat(64)}`);
  await assert.rejects(
    store.readExact({
      ...IDENTITY,
      issuanceDigest: ISSUANCE_DIGEST,
      publicKey,
      now: NOW,
    }),
    /FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_ROW_DRIFT/u,
  );

  const fresh = memoryClient();
  const privateStore = createFleetMigrationAuthoritativeIssuanceStore(fresh.client as never, {
    validateAuthoritative: trustedValidator,
  });
  await assert.rejects(
    privateStore.preserve({
      ...IDENTITY,
      issuance: issuance({ secret: "must-never-be-stored" }),
      publicKey,
      now: NOW,
    }),
    /FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_PRIVATE_SURFACE_REJECTED/u,
  );
});

test("expired issuance는 replay하거나 caller readback에 사용하지 않는다", async () => {
  const memory = memoryClient();
  const store = createFleetMigrationAuthoritativeIssuanceStore(memory.client as never, {
    validateAuthoritative: trustedValidator,
  });
  await assert.rejects(
    store.preserve({
      ...IDENTITY,
      issuance: issuance(),
      publicKey,
      now: new Date("2026-08-31T08:14:00.000Z"),
    }),
    /FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_EXPIRED/u,
  );
});
