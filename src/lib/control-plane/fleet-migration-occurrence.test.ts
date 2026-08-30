import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import {
  computeFleetMigrationFinalizationDigest,
  createFleetMigrationOccurrenceStore,
} from "@/lib/control-plane/fleet-migration-occurrence";
import type { JsonValue } from "@/lib/control-plane/json";

const PROVIDER_DIGEST = `sha256:${"a".repeat(64)}`;
const INVENTORY_DIGEST = `sha256:${"b".repeat(64)}`;
const COLLECTION_DIGEST = `sha256:${"c".repeat(64)}`;
const FINAL_GITHUB_DIGEST = `sha256:${"d".repeat(64)}`;
const FINAL_BACKOFFICE_DIGEST = `sha256:${"e".repeat(64)}`;
const FINALIZATION_DIGEST = `sha256:${"f".repeat(64)}`;
const VALID_COLLECTION_GZIP_BASE64 = "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";

function fakeClient() {
  const claims = new Map<string, {
    id: string;
    deliveryId: string;
    runId: string;
    providerVectorDigest: string;
    inventoryDigest: string;
  }>();
  const completions = new Map<string, Record<string, unknown>>();
  const occurrenceModel = {
    async findUnique(input: { where: { id?: string; deliveryId?: string }; include?: { completion?: unknown } }) {
      const row = input.where.id
        ? claims.get(input.where.id)
        : [...claims.values()].find((candidate) => candidate.deliveryId === input.where.deliveryId);
      if (!row) return null;
      return input.include?.completion
        ? { ...row, completion: completions.get(row.id) ?? null }
        : row;
    },
    async create(input: { data: { deliveryId: string; runId: string; providerVectorDigest: string; inventoryDigest: string } }) {
      const id = `occurrence-${String(claims.size + 1).padStart(8, "0")}`;
      const row = { id, ...input.data };
      claims.set(id, row);
      return row;
    },
  };
  const completionModel = {
    async findUnique(input: { where: { occurrenceId: string } }) {
      return completions.get(input.where.occurrenceId) ?? null;
    },
    async create(input: { data: Record<string, unknown> }) {
      const row = { id: `completion-${String(completions.size + 1).padStart(8, "0")}`, ...input.data };
      completions.set(String(input.data.occurrenceId), row);
      return row;
    },
  };
  const client = {
    fleetMigrationCollectionOccurrence: occurrenceModel,
    fleetMigrationCollectionCompletion: completionModel,
  };
  return { client, claims, completions };
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

function validCollection(): Record<string, unknown> {
  return JSON.parse(gunzipSync(Buffer.from(VALID_COLLECTION_GZIP_BASE64, "base64")).toString("utf8")) as Record<string, unknown>;
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
  assert.equal(fixture.claims.size, 2);
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
    finalGithubDigest: FINAL_GITHUB_DIGEST,
    finalBackofficeDigest: FINAL_BACKOFFICE_DIGEST,
    finalizationDigest: FINALIZATION_DIGEST,
    collection: {
      contract: "seorilabs-fleet-migration-collection-v1",
      inventoryDigest: INVENTORY_DIGEST,
      collectionDigest: COLLECTION_DIGEST,
      secretValue: "never persist this",
    },
  }), /FLEET_MIGRATION_COLLECTION_PRIVATE_SURFACE_REJECTED/);
  assert.equal(fixture.completions.size, 0);
});

test("completion is a separate exact-once INSERT and readback rejects a tampered fence", async () => {
  const fixture = fakeClient();
  const store = createFleetMigrationOccurrenceStore(fixture.client as never);
  const collection = validCollection();
  const occurrence = collection.occurrence as {
    occurrenceId: string;
    runId: string;
    providerVectorDigest: string;
  };
  const inventoryDigest = String(collection.inventoryDigest);
  const collectionDigest = String(collection.collectionDigest);
  const deliveryId = "fleet-collector-delivery-0001";
  fixture.claims.set(occurrence.occurrenceId, {
    id: occurrence.occurrenceId,
    deliveryId,
    runId: occurrence.runId,
    providerVectorDigest: occurrence.providerVectorDigest,
    inventoryDigest,
  });
  const base = {
    occurrenceId: occurrence.occurrenceId,
    runId: occurrence.runId,
    deliveryId,
    providerVectorDigest: occurrence.providerVectorDigest,
    inventoryDigest,
    collectionDigest,
    finalGithubDigest: FINAL_GITHUB_DIGEST,
    finalBackofficeDigest: FINAL_BACKOFFICE_DIGEST,
  };
  const request = {
    ...base,
    finalizationDigest: computeFleetMigrationFinalizationDigest(base),
    collection: collection as JsonValue,
  };
  const completed = await store.complete(request);
  const replay = await store.complete(request);
  assert.deepEqual(replay, completed);
  assert.equal(fixture.completions.size, 1);
  assert.deepEqual(await store.read({
    occurrenceId: occurrence.occurrenceId,
    runId: occurrence.runId,
    providerVectorDigest: occurrence.providerVectorDigest,
  }), collection);

  const conflictingBase = { ...base, finalBackofficeDigest: `sha256:${"1".repeat(64)}` };
  await assert.rejects(store.complete({
    ...request,
    ...conflictingBase,
    finalizationDigest: computeFleetMigrationFinalizationDigest(conflictingBase),
  }), /FLEET_MIGRATION_COLLECTION_COMPLETION_CONFLICT/);

  const stored = fixture.completions.get(occurrence.occurrenceId)!;
  stored.finalizationDigest = `sha256:${"2".repeat(64)}`;
  await assert.rejects(store.read({
    occurrenceId: occurrence.occurrenceId,
    runId: occurrence.runId,
    providerVectorDigest: occurrence.providerVectorDigest,
  }), /FLEET_MIGRATION_COLLECTION_OCCURRENCE_READBACK_MISSING/);
});
