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
