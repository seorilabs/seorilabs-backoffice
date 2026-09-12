import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createFleetMigrationAuthoritativeIssuanceStore } from "@/lib/control-plane/fleet-migration-authoritative-issuance";

const NOW = new Date("2026-08-31T08:00:00.000Z");
const INVENTORY_DIGEST = `sha256:${"1".repeat(64)}`;
// 발급기가 수집본 inventory에 issuance capability를 더한 뒤 digest를 다시 계산하므로
// 발급본과 수집본의 inventoryDigest는 원래 다르다. fixture가 둘을 같은 값으로 두면
// 그 전제가 계약과 어긋나고, 실제로 발급이 영구히 막히는 결함을 덮는다.
const COLLECTION_INVENTORY_DIGEST = `sha256:${"5".repeat(64)}`;
const COLLECTION_DIGEST = `sha256:${"6".repeat(64)}`;
const CAPABILITY_EVIDENCE_DIGEST = `sha256:${"7".repeat(64)}`;
const ISSUANCE_DIGEST = `sha256:${"2".repeat(64)}`;
const PROVIDER_DIGEST = `sha256:${"3".repeat(64)}`;
const KEY_FINGERPRINT = `sha256:${"4".repeat(64)}`;
const IDENTITY = {
  occurrenceId: "fleet-occurrence-0001",
  runId: "fleet-run-0001",
  providerVectorDigest: PROVIDER_DIGEST,
};
const COLLECTION = {
  inventoryDigest: COLLECTION_INVENTORY_DIGEST,
  collectionDigest: COLLECTION_DIGEST,
  capabilityEvidenceDigest: CAPABILITY_EVIDENCE_DIGEST,
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
    collectionCapabilityEvidenceDigest: CAPABILITY_EVIDENCE_DIGEST,
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
    inventoryDigest: COLLECTION_INVENTORY_DIGEST,
    collectionDigest: COLLECTION_DIGEST,
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
    collection: COLLECTION,
    issuance: issuance(),
    publicKey,
    now: NOW,
  });
  assert.equal(first.state, "PRESERVED");
  assert.equal(first.issuance.issuanceDigest, ISSUANCE_DIGEST);

  const replay = await store.preserve({
    ...IDENTITY,
    collection: COLLECTION,
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
    collection: COLLECTION,
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
      collection: COLLECTION,
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
      collection: COLLECTION,
      issuance: issuance(),
      publicKey,
      now: new Date("2026-08-31T08:14:00.000Z"),
    }),
    /FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_EXPIRED/u,
  );
});

test("발급본 inventoryDigest가 수집본과 달라도 completion 결합은 성립한다", async () => {
  const memory = memoryClient();
  const store = createFleetMigrationAuthoritativeIssuanceStore(memory.client as never, {
    validateAuthoritative: trustedValidator,
  });
  // 이것이 실제로 막혀 있던 경로다. 발급기는 수집본 inventory에 issuance capability를
  // 더해 digest를 다시 계산하므로 두 값이 같을 수 없는데, 종전 구현은 발급본 digest를
  // 완료 기록과 비교해 COMPLETION_MISMATCH로 영구히 거절했다.
  assert.notEqual(INVENTORY_DIGEST, COLLECTION_INVENTORY_DIGEST);
  const preserved = await store.preserve({
    ...IDENTITY,
    collection: COLLECTION,
    issuance: issuance(),
    publicKey,
    now: NOW,
  });
  assert.equal(preserved.state, "PRESERVED");
  assert.equal(preserved.issuance.inventoryDigest, INVENTORY_DIGEST);
});

test("수집본 결합이 틀리면 보존하지 않는다", async () => {
  const wrongCollection = memoryClient();
  const wrongStore = createFleetMigrationAuthoritativeIssuanceStore(wrongCollection.client as never, {
    validateAuthoritative: trustedValidator,
  });
  await assert.rejects(
    wrongStore.preserve({
      ...IDENTITY,
      collection: { ...COLLECTION, inventoryDigest: `sha256:${"8".repeat(64)}` },
      issuance: issuance(),
      publicKey,
      now: NOW,
    }),
    /FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_COMPLETION_MISMATCH/u,
  );

  const wrongDigest = memoryClient();
  const digestStore = createFleetMigrationAuthoritativeIssuanceStore(wrongDigest.client as never, {
    validateAuthoritative: trustedValidator,
  });
  await assert.rejects(
    digestStore.preserve({
      ...IDENTITY,
      collection: { ...COLLECTION, collectionDigest: `sha256:${"8".repeat(64)}` },
      issuance: issuance(),
      publicKey,
      now: NOW,
    }),
    /FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_COMPLETION_MISMATCH/u,
  );

  // 발급본이 다른 수집본에서 나왔으면 완료 기록이 맞더라도 거절한다.
  const foreign = memoryClient();
  const foreignStore = createFleetMigrationAuthoritativeIssuanceStore(foreign.client as never, {
    validateAuthoritative: trustedValidator,
  });
  await assert.rejects(
    foreignStore.preserve({
      ...IDENTITY,
      collection: COLLECTION,
      issuance: issuance({ collectionCapabilityEvidenceDigest: `sha256:${"8".repeat(64)}` }),
      publicKey,
      now: NOW,
    }),
    /FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_COLLECTION_MISMATCH/u,
  );
});
