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
const VALID_COLLECTION_GZIP_BASE64 = "H4sIAAAAAAACE+1ZbXPbuBH+L/gsJQAIgIC+OY5z5zaNPbJy0zbj8SyAhcQJRfJISolz4//eAUVJlC0rTq8vN9Nq9EEEF8Diwe6zL/qNuLJoa3AtmZAGyzrLwTbjkCO242U2r6HNymLsyjxH1/1cMzIiTQstkgl5d/nX2cfpxd351V+u31/MLsiIwKpdlHXWQputkUwC5A2OSI3g79+V9XUORZEV892LZekHC5ERKZ1b1TUWDsnkt8HTpScTstFrPzj2KFLgVgTkLnAhtBKCjEi9KgbyvfZlPa5XxZhSGo9Q1eU681j/0r15m82x6TBYAJdqcmxdrmgSBDOguAefuKCs8EHy1DDPUfsk8QKltpZpRR5GJCvWWLRlff94ccOTxBotuRFGGe8wSajgHB0GgxIoM8KjkCIFyyENliZgIPVMcwzMBEMGa0eQGrfAJfyCdZOVBZkkg9cDFHZjAzx6LBxU7apGfxaV5JSrMdXjhM4onXTfV5TSv5MRwa9VVmNzRIzJgVhZz6HIvnWmE/XLohJcJ4xJmsT98nKeFUODi3B5bDul4owaq7LJdgcwdPOJc8Mqzz/AEofTX7+aZ+1iZaNllqva4RQDmZAaQ/N6geCb10vIit3bmwWQCcEXfiI+ex957BlrFnV35RprmHcmuzUsMiE/Xc5+/vjm7uz6+u7yw83s7P37s9nl1Ye76cX11c3l7Gr6t7vpxdnbN2fnf+7utGkhz7t1u2MzwRmnNE3JiPy6ws1lD8F9/wTHEYHaLbI1+p2HVTDHm+wbkgmnDxtPtOA+dztsYBvv4R5H6fFWZmsfTQFVsyjbU3O2Mts5pW2wXj+yKW5mPJlIPTAWVy6rHCObtPUKR6TAr+35qm6iIRSrPN976qxsIT8vV0VLJmxEwEWGme7U2L/ZqZZh89j3eAhoKU1pEAIEY54Go4NxiilBOdMJSgzCGrTa+xA8IFXepYwr752V0fficRsy+fRb9+vDamnjZXf7/rrC5pH2NTZVWTT44cm5FtDEwevObvrLeilqz2Ay9JuoImG939xu1H6MhtBAg0aWGGlQqwAUmTHSYki0pxRQSu2plTwwBAM0kcpIFTgTKqQ+BPJw+9DRAroWfadHE4300d1kES82IjnOwd1fVbhxnj81kR/oiHwp688hL7/coKuxbS6LBdZZe/DqXV5CmxXzzrOjHedZgb3H9THkzdXV7GY2PbsmI/IF1ruboRGurKwvh6S4Na3h+BadwbvzATMOhq/6a9qeuL/qsmyPbHIwfLiHW0BWHA5B4bBpo69/uu2YZRt5L+KF92HxR4J2WY+xn7oJ3k9C7sajz6rqHCqwWZ6199/ZpOcAqKqx283ZrF7jOtvEIXJcKs/WOF4Va6yzkKF/CV+YSfI7gwtU1SauPCW/qN6O8OLGVHOz1apbXTAuhFCRCPPV/ACOOKkMIXMxTJRfCqwvH+vTjR5lardJkTa89wXtoiw/nx0b/FjnZEIWbVs1k9ev93u+Wn+7//rq6/2311Blr3vhuHSF9TJr4jVsiKrYBEzoDGmzt8OmIRPypc5aJA+jvYxfZkXWtBsjOinqFug+H6wWcTyQKIsWo4ecWgaLdVaXxfK7glnTrPC0yBKjz5/UaYkteGjhlMzQyO5+AJFqled3fRg4reieqe/cqmnL5V1VlxXWbfadE24J8ZjU7YjguoNx8mmD1p0rlxHYaMpb9IZKdo/NguyJ9q5eFeT24TAdec53hjLfcaJhMgNVdXnoWOBcpNInztOPH3OfFuo5trP7KqJyNWSFYRy8wZ4+o2nnefThVVNh4Yecvqo8tM9RzyDo/t+r/ie96qF3qzPnsGqhj8HbGvjjh18uppfvLi/ekl7uQBESK5sY84YpAXQrDU1wAYXPsZ7uomcvWFXTH45ZA6ec/tNOu80ZHqeM2lkEE4z2QiVcusBNCgl1SIOlQTMnlOFgVQBlU2Y0OgjBogHH0HHTlUvPrR24BZlK60AlUigrlLYhUcZwKrxKLBeJ94ajDsFLi8w7Cy4oRGN0Cjzpqu6mWcUr+ilrf36S1BwWFP+m0n9IP/uk7dOTqpadrmmrHNpQ1ssfK2qpREGDdx0yLNEi9YA6pcYFsCH1nltvOxJua+wnOVCQJgFQpmkIgVGfOE6Fc1JDIrj1ILwJUg002RhNdIOQ1U17zMyijnvz6g877o4bp1ydrHTYjnRDVkD+8vX5dsrp9eVu/T8Ots95hdSJ4VwhBCl0kghIjNNGcYtMM0d9yoXUmiJXyD0H5zlw552B4J1OkkjBnULHQIzjT0AkI2Lz0m7lY7C73QxdPtvSAsVSSLShISTBSqODcAyFZswYECZoSIVDxlMZUiXQCGq99UqhYYlgMWwMUumXVjj7KeNqZfPMDSodTh71OgbCRw58uvA+Xn48yVZ+p4P/sJm5HJomC5nrkzRy/f5s9u5q+pe76+nV24/nF9MnQm/RdQFmH2jYcyLdGQZtnkOpGCco6SurbVSLtct5WYRsvh1rsnmB/qZvDu0YuD/6u3ihb7LCdy3hQ3beODC0fbp1OyKuRo9Fm0HeT+nHn3Mc7kIanBYmYTpQzwMKF1utCAnzmjoErURqmReMukR4ybVnNE2kCUEIDKdCVeKd8IojN9RTYRi3zqQ6iKBBcRDAU2Usw1Qx5ZTVCrz2CgQylJ5xB32y/oziUlNJgSphvJQmRaslJjwVLg0WMRgvLDegpTScoU2co5IyK4MTztmN4vVB8+Ug+uzK5pcbqMcAq7z9F9Pkk15lKOvPu4f/vnU/bHnhsNuwoSGfNV3b934Xex6f/Lu0so9CzzLHHyc8DUPI8T73T5ezu9n04oIc7zI/F2tOY8TkCzH6z6BQo1vVzaBF09arwsXqcWe3WLTDbnSMm/unxkFRoH+zH6Tx/5eiLDIH+UXRHmtaI6YcONeGipAYIX0wDlIepOY6VtCCp1In1CZoqRBSy9QwByz1XKtgqTmRXDAF1CQ+TR0PRjOtNKOxESy0oE4htyZlGNJEmTSkWrEQrEapqUuYF5J16Xzo2fiJ2tZKo2hg4FF55oNynMvEIzDHITUWpAbNEuYTzxSalDqWeFCKSeZVyrt/VqDwWazOO66PpAlti7H22lVJB13SJ4mJRk0VMuG99l4LG6RBmVAVmMM0COdSpjmnNKQSHApOlQvepCpoAVZZ8vAPDvRlpyMdAAA=";

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
