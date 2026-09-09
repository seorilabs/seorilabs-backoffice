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
const VALID_COLLECTION_GZIP_BASE64 = "H4sIAAAAAAACE+1Z23LbOBL9FzxLCW7ERW+O48x4Nxu7ZGVqd1MpVwNoWKzQJIeklDhT/vctUJRE2bKT7OxlqnZVfrDABtg46D4H3fqN+KrsGvAdmZEWqyYvwLXTWCB209v8poEur8qpr4oCff/vmpEJaTvokMzIm/O/Lt7Pz65PL/5y+fZscUYmBFbdsmryDrp8jWQWoWhxQhqEcPemai4LKMu8vNk9uK3CaCEyIZX3q6bB0iOZ/Tb6dh7IjGz82g9OA0oN3MmI3EcupVFSkglpVuXIfvC+aqbNqpxSStMW6qZa5wGbX/onr/MbbHsMlsAzNTu2LldURMksKB4gCB+VkyFmXFsWOJogRJCYGeeYUeR+QvJyjWVXNXcPFzchCuFNDMyBkgFMdNQoF3TgHoVXxqMOoGNmlOZRW2FRCeqNQu2iVZyM1k4gtX6Jt/ALNm1elWQmR49HKOzGRngMWHiou1WD4SQ5ySlXU2qmgi4onfV/LyilfycTgl/qvMH2iBnLRmZVcwNl/rUPneRfnpzgRjCWUZHeV1Q3eTkOuARXwK53Ks1osK7afLcBSzefNDeuiuId3OJ4+ssXN3m3XLkUmdWq8TjHSGakwdi+XCKE9uUt5OXu6dUSyIzgd34SPvsceZgZa5Z899UaG7jpQ3YbWGRGfjpf/Pz+1fXJ5eX1+burxcnbtyeL84t31/Ozy4ur88XF/G/X87OT169OTv/cn2nbQVH06/bbZpIzTqnWZEJ+XeHmsMfgvn2E44RA45f5GsMuw2q4wav8K5IZp/ebTHTgP/Vv2MA23cM9TdbTrc02PtoS6nZZdc/N2dps51SuxWb9IKa4XXAxy8woWHx1WxeY2KRrVjghJX7pTldNmwKhXBXFPlMXVQfFabUqOzJjEwI+Mcx858b+yc61HNuHucdjREepplFKkIwFGq2J1iumJOXMCMwwSmfRmRBiDIBUBa8ZVyF4l1myAbQlsw+/9f+9W926dNj9e39dYfvA+wbbuipbfPdoX0to0+BlHzfDYX0vak9gMs6b5CJhQ9583Lj9EA1pgEaDTNjMolERKDJrM4dRmEApYJaZQF3GI0OwQEWmbKYiZ1JFHWIk9x/ve1pA32Ho/WhTkD44mzzhxSakwBvwdxc1bpLnT23iBzohn6vmUyyqz1foG+za83KJTd4dPHpTVNDl5U2f2SmOi7zEIeMGDXl1cbG4WsxPLsmEfIb17mRogiuvmvMxKW5Dazy+RWf07HTEjKPhi+GYtjsejrqquiMvORg+fIdfQl4eDkHpse1Srn/42DPLVnnP0oEPsvgjol01UxymbsT7keRuMvqkrk+hBpcXeXf3jZcMHAB1PfW7OZvVG1znGx0ix62KfI3TVbnGJo85hu/hCzsTv1NcoK43uvKY/JJ7O8JLL6aG261X/eqScSmlSkRYrG4O4EiTqhhzn2Si+lxic/7Qn370KFP7zRVpw3uf0S2r6tPJscH3TUFmZNl1dTt7+XL/zhfrr3dfXny5+/oS6vzlYJyWrrG5zdt0DBuiKjeCCX0gbd7tsW3JjHxu8g7J/WRvE27zMm+7TRA9a+qX6D8drJZwPLCoyg5Thjy3DJbrvKnK228a5m27wudNbjHl/LM+3WIHATp4zmYcZNc/gEi9KorrQQaed3TP1Nd+1XbV7XXdVDU2Xf6NHW4J8ZjVxwnBdQ/j7MMGrWtf3SZgUyhv0Rs72X9tl2RPtNfNqiQf7w+vI0/lztjmG0k0vsxAXZ8fJhZ4n6j0UfIM48fSp4PmBrvFXZ1QuRizwlgHr3CgzxTaRZFyeNXWWIYxp6/qAN1T1DMS3f9n1f9kVt0PaXXiPdYdDBq8rYHfv/vlbH7+5vzsNRnsDhwhqbJJmje+EkC/0jgEl1CGApv5Tj0Hw7qe/7BmjZJy/k8n7fbO8Kh49Q7BRmuCVIJnPnKrQVCPNDoaDfNSWQ5ORVBOM2vQQ4wOLXiGntu+XHpq7cgdZDpzHpTIpHJSGReFspZTGZRwXIoQLEcTY8gcsuAd+KgQrTUauOir7rZdpSP6Ke9+fnSpOSwo/k2l/5h+9pe2D4+qWvZ8TVsX0MWquf2xopZmKGkMvkeGCSN1ADSaWh/BRR0Cd8H1JNw1OEzyoECLCJhpHWNkNAjPqfQ+MyAkdwFksDFTI082QZPSIOZN2x0Ls+TjPryGzU777aYpF89WOmxHujEvofj+9fl2yvPrZ7v1/zjYPpUVmRGWc4UQM2mEkCCsN1Zxh8wwT4PmMjOGIlfIAwcfOHAfvIUYvBEiUXDv0DEQ0/gjEMmEuKJyW/skdh83Q+dPtbQsKKZBGEtjFNFl1kTpGUrDmLUgbTSgpUfGdRa1kmgldcEFpdAyIVmSjdFV+nsrnP2Uab1yRe5HlY4gD3odI+MjG36+8D5efjy6rfzOBP/hMPMFtG0ecz9c0sjl25PFm4v5X64v5xev35+ezR8ZvUbfC8xeaNhTJv0eRm2eQ6ukE5QMldVW1VLtclqVMb/ZjrX5TYnhamgO7Rh42PqbdKCv8jL0LeFDdt4kMHTDdevjhPgGA5ZdDsUwZRh/Uk4U555nIlNOK+dURqMAm2mvabTOSYhKWgOSUuRaSQjWCMSgQwzgLMbnpEpxTcE6hjFpFCquOSjPqNfOOxF0gCwDTxUqI7gXTAtHJaXGx0xbyvlwWX9icaGV8TY1ZJS3Bry3jrlAg7ZUIjobvc0CpRSUY4Eq5jWTPgiRBSaM6jO+OWi+HKjPrmz+/gANGGFVdP9imnzUq4xV82n35b8f3fdbXjjsNmxoKORt3/a922nPw51/k1b2KvQkc/xx5GksIcf73D+dL64X87MzcrzL/JTWPI8Ry74To/8MCg36VdOOWjRdsyp9qh53cYtlN+5GJ93cf2s9lCWGV/tBmn5/Kasy91Ccld2xpjWi5sC5sVRGYWUWovWgecwMN6mCllxnRlAn0FEpM5NpyzwwHbhR0VH7zOWCKaBWBK09j9YwowyjiXekkdQr5M5qhlELZXXURrEYncHMUC9YkBnrr/NxYONHbjuXWUUjg4AqsBCV5zwTAYF5Dto6yAwYJlgQgSm0mnomAijFMhaU5v0vK1CGPFXnPdcn0oSuw1R77aqkgy7pQx/AOYWoreXpVzSpvRAKBUgMPviMSh5BMsupE0aBCanTTZWjnlJuuURN7v8BQ0cdIyMdAAA=";

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
