import assert from "node:assert/strict";
import test from "node:test";

import { createFleetMigrationOccurrenceStore } from "@/lib/control-plane/fleet-migration-occurrence";

const PROVIDER_DIGEST = `sha256:${"a".repeat(64)}`;
const INVENTORY_DIGEST = `sha256:${"b".repeat(64)}`;
const COLLECTION_DIGEST = `sha256:${"c".repeat(64)}`;

function fakeClient() {
  const rows = new Map<string, {
    id: string;
    deliveryId: string;
    runId: string;
    providerVectorDigest: string;
    inventoryDigest: string;
    status: "CLAIMED" | "COMPLETED";
    collectionDigest: string | null;
    collection: unknown;
  }>();
  const model = {
    async findUnique(input: { where: { id?: string; deliveryId?: string } }) {
      if (input.where.id) return rows.get(input.where.id) ?? null;
      return [...rows.values()].find((row) => row.deliveryId === input.where.deliveryId) ?? null;
    },
    async create(input: { data: { deliveryId: string; runId: string; providerVectorDigest: string; inventoryDigest: string } }) {
      const id = `occurrence-${String(rows.size + 1).padStart(8, "0")}`;
      const row = { id, ...input.data, status: "CLAIMED" as const, collectionDigest: null, collection: null };
      rows.set(id, row);
      return row;
    },
    async updateMany() {
      throw new Error("unexpected update");
    },
  };
  const client = {
    fleetMigrationCollectionOccurrence: model,
    async $transaction<T>(callback: (transaction: { fleetMigrationCollectionOccurrence: typeof model }) => Promise<T>) {
      return callback({ fleetMigrationCollectionOccurrence: model });
    },
  };
  return { client, rows };
}

function claim(deliveryId: string, requestedRunId: string) {
  return {
    contract: "seorilabs-fleet-migration-collection-v1",
    deliveryId,
    requestedRunId,
    providerVectorDigest: PROVIDER_DIGEST,
    inventoryDigest: INVENTORY_DIGEST,
  };
}

test("same delivery resumes while two Job UIDs create independently auditable occurrences", async () => {
  const fixture = fakeClient();
  const store = createFleetMigrationOccurrenceStore(fixture.client as never);
  const first = await store.claim(claim("fleet-job-00000000-0000-0000-0000-000000000001", "fleet-pod-00000000-0000-0000-0000-000000000001"));
  const replay = await store.claim(claim("fleet-job-00000000-0000-0000-0000-000000000001", "fleet-pod-00000000-0000-0000-0000-000000000001"));
  const second = await store.claim(claim("fleet-job-00000000-0000-0000-0000-000000000002", "fleet-pod-00000000-0000-0000-0000-000000000002"));
  assert.equal(first.state, "CLAIMED");
  assert.equal(replay.state, "RESUME");
  assert.equal(replay.occurrenceId, first.occurrenceId);
  assert.equal(second.state, "CLAIMED");
  assert.notEqual(second.occurrenceId, first.occurrenceId);
  assert.equal(fixture.rows.size, 2);
});

test("delivery replay with a different run identity fails closed", async () => {
  const fixture = fakeClient();
  const store = createFleetMigrationOccurrenceStore(fixture.client as never);
  const deliveryId = "fleet-job-00000000-0000-0000-0000-000000000001";
  await store.claim(claim(deliveryId, "fleet-pod-00000000-0000-0000-0000-000000000001"));
  await assert.rejects(
    store.claim(claim(deliveryId, "fleet-pod-00000000-0000-0000-0000-000000000099")),
    /FLEET_MIGRATION_COLLECTION_OCCURRENCE_CLAIM_CONFLICT/,
  );
});

test("secret-shaped collection is rejected before a durable completion write", async () => {
  const fixture = fakeClient();
  const store = createFleetMigrationOccurrenceStore(fixture.client as never);
  const claimed = await store.claim(claim("fleet-job-00000000-0000-0000-0000-000000000001", "fleet-pod-00000000-0000-0000-0000-000000000001"));
  await assert.rejects(store.complete({
    occurrenceId: claimed.occurrenceId,
    runId: claimed.runId,
    deliveryId: "fleet-job-00000000-0000-0000-0000-000000000001",
    providerVectorDigest: PROVIDER_DIGEST,
    inventoryDigest: INVENTORY_DIGEST,
    collectionDigest: COLLECTION_DIGEST,
    collection: {
      contract: "seorilabs-fleet-migration-collection-v1",
      inventoryDigest: INVENTORY_DIGEST,
      collectionDigest: COLLECTION_DIGEST,
      secretValue: "never persist this",
    },
  }), /FLEET_MIGRATION_COLLECTION_PRIVATE_SURFACE_REJECTED/);
  assert.equal(fixture.rows.get(claimed.occurrenceId)?.status, "CLAIMED");
});
