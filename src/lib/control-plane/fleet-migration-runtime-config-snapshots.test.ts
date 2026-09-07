import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildFleetMigrationRuntimeConfigSnapshots,
  type FleetMigrationRuntimeApp,
  type FleetMigrationRuntimeCohortRepository,
} from "@/lib/control-plane/fleet-migration-runtime-config-snapshots";

const SOURCE_SHA = "a".repeat(40);
const OTHER_SOURCE_SHA = "b".repeat(40);

function repository(
  repoId: string,
  classification: string | null,
  sourceSha: string | null = SOURCE_SHA,
): FleetMigrationRuntimeCohortRepository {
  return { repoId, classification, sourceSha };
}

function app(repoId: string, overrides: Partial<FleetMigrationRuntimeApp> = {}): FleetMigrationRuntimeApp {
  return {
    id: `app-${repoId}`,
    repoId,
    activeConfigs: [{
      id: `config-${repoId}`,
      activatedSnapshot: `snapshot-${repoId}`,
      snapshotDigest: `digest-${repoId}`,
      snapshotSignature: `signature-${repoId}`,
    }],
    ...overrides,
  };
}

const acceptAll = () => true;

test("제품 앱이 아닌 cohort 저장소의 App은 config snapshot을 요구하지 않는다", () => {
  const snapshots = buildFleetMigrationRuntimeConfigSnapshots({
    repositories: [
      repository("101", "PRODUCT_APP"),
      repository("102", "PLATFORM_PRODUCER"),
      repository("103", "INFRA_REPO"),
      repository("104", null),
    ],
    // PLATFORM_PRODUCER는 분류 도입 전 App row가 남아 ACTIVE config가 0개다.
    apps: [
      app("101"),
      { id: "app-102", repoId: "102", activeConfigs: [] },
      { id: "app-103", repoId: "103", activeConfigs: [] },
      { id: "app-104", repoId: "104", activeConfigs: [] },
    ],
    verifySnapshot: acceptAll,
  });

  assert.deepEqual(snapshots.map((snapshot) => snapshot.repositoryId), ["101"]);
});

test("제품 앱에 ACTIVE config가 없으면 발급을 중단한다", () => {
  assert.throws(
    () => buildFleetMigrationRuntimeConfigSnapshots({
      repositories: [repository("101", "PRODUCT_APP")],
      apps: [{ id: "app-101", repoId: "101", activeConfigs: [] }],
      verifySnapshot: acceptAll,
    }),
    /FLEET_MIGRATION_RUNTIME_SNAPSHOT_INVALID/u,
  );
});

test("제품 앱의 snapshot 서명이 검증되지 않으면 발급을 중단한다", () => {
  assert.throws(
    () => buildFleetMigrationRuntimeConfigSnapshots({
      repositories: [repository("101", "PRODUCT_APP")],
      apps: [app("101")],
      verifySnapshot: () => false,
    }),
    /FLEET_MIGRATION_RUNTIME_SNAPSHOT_INVALID/u,
  );
});

test("digest, signature, snapshot 중 하나라도 없으면 발급을 중단한다", () => {
  const missing: Array<Partial<FleetMigrationRuntimeApp["activeConfigs"][number]>> = [
    { snapshotDigest: null },
    { snapshotSignature: null },
    { activatedSnapshot: null },
  ];
  for (const override of missing) {
    assert.throws(
      () => buildFleetMigrationRuntimeConfigSnapshots({
        repositories: [repository("101", "PRODUCT_APP")],
        apps: [app("101", {
          activeConfigs: [{
            id: "config-101",
            activatedSnapshot: "snapshot-101",
            snapshotDigest: "digest-101",
            snapshotSignature: "signature-101",
            ...override,
          }],
        })],
        verifySnapshot: acceptAll,
      }),
      /FLEET_MIGRATION_RUNTIME_SNAPSHOT_INVALID/u,
    );
  }
});

test("ACTIVE config가 둘 이상이면 발급을 중단한다", () => {
  assert.throws(
    () => buildFleetMigrationRuntimeConfigSnapshots({
      repositories: [repository("101", "PRODUCT_APP")],
      apps: [app("101", {
        activeConfigs: [
          { id: "config-a", activatedSnapshot: "s", snapshotDigest: "d", snapshotSignature: "g" },
          { id: "config-b", activatedSnapshot: "s", snapshotDigest: "d", snapshotSignature: "g" },
        ],
      })],
      verifySnapshot: acceptAll,
    }),
    /FLEET_MIGRATION_RUNTIME_SNAPSHOT_INVALID/u,
  );
});

test("cohort에 없는 App은 조용히 제외되고 결과를 오염시키지 않는다", () => {
  const snapshots = buildFleetMigrationRuntimeConfigSnapshots({
    repositories: [repository("101", "PRODUCT_APP")],
    apps: [app("101"), app("999")],
    verifySnapshot: acceptAll,
  });

  assert.deepEqual(snapshots.map((snapshot) => snapshot.repositoryId), ["101"]);
});

test("제품 앱의 source SHA가 없거나 40자리가 아니면 발급을 중단한다", () => {
  for (const sourceSha of [null, "not-a-sha"]) {
    assert.throws(
      () => buildFleetMigrationRuntimeConfigSnapshots({
        repositories: [repository("101", "PRODUCT_APP", sourceSha)],
        apps: [app("101")],
        verifySnapshot: acceptAll,
      }),
      /FLEET_MIGRATION_RUNTIME_SNAPSHOT_INVALID/u,
    );
  }
});

test("결과는 repository ID 숫자 순으로 정렬되고 signature는 digest로만 나간다", () => {
  const snapshots = buildFleetMigrationRuntimeConfigSnapshots({
    repositories: [
      repository("1000", "PRODUCT_APP", SOURCE_SHA),
      repository("99", "PRODUCT_APP", OTHER_SOURCE_SHA),
    ],
    apps: [app("1000"), app("99")],
    verifySnapshot: acceptAll,
  });

  assert.deepEqual(snapshots.map((snapshot) => snapshot.repositoryId), ["99", "1000"]);
  assert.equal(snapshots[0]!.sourceSha, OTHER_SOURCE_SHA);
  assert.equal(
    snapshots[0]!.snapshotSignatureDigest,
    createHash("sha256").update("signature-99").digest("hex"),
  );
  assert.equal(
    JSON.stringify(snapshots).includes("signature-99"),
    false,
    "raw signature가 결과에 남으면 안 된다",
  );
});
