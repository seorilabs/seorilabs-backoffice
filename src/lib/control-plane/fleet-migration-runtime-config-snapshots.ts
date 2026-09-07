import { createHash } from "node:crypto";

import type { JsonValue } from "@/lib/control-plane/json";

const SHA = /^[0-9a-f]{40}$/u;

/**
 * runtime capability에 실을 config snapshot 집합을 만든다.
 *
 * 경계는 readiness와 같아야 한다. `fleet-migration-shadow-readiness`는
 * `classification !== "PRODUCT_APP"`이면 early return해서 ACTIVE config와 signed snapshot을
 * 요구하지 않는다. PLATFORM_PRODUCER처럼 제품 앱이 아닌 저장소의 App row는 config revision을
 * 가질 이유가 없고, 발급기가 그걸 요구하면 readiness가 READY인데도 발급이 영구히 막힌다.
 *
 * 제품 앱의 요구조건은 그대로 fail-closed다. ACTIVE config 정확히 1개, digest·signature 존재,
 * 서명 검증 통과가 아니면 발급을 중단한다.
 */
export type FleetMigrationRuntimeCohortRepository = {
  repoId: string;
  classification: string | null;
  sourceSha: string | null;
};

export type FleetMigrationRuntimeApp = {
  id: string;
  repoId: string;
  activeConfigs: Array<{
    id: string;
    activatedSnapshot: JsonValue;
    snapshotDigest: string | null;
    snapshotSignature: string | null;
  }>;
};

export type FleetMigrationRuntimeConfigSnapshot = {
  repositoryId: string;
  appId: string;
  configRevisionId: string;
  sourceSha: string;
  snapshotDigest: string;
  snapshotSignatureDigest: string;
};

export function buildFleetMigrationRuntimeConfigSnapshots(input: {
  repositories: readonly FleetMigrationRuntimeCohortRepository[];
  apps: readonly FleetMigrationRuntimeApp[];
  verifySnapshot: (input: {
    snapshot: JsonValue;
    digest: string;
    signature: string;
  }) => boolean;
}): FleetMigrationRuntimeConfigSnapshot[] {
  const currentSources = new Map(
    input.repositories.map((repository) => [repository.repoId, repository.sourceSha]),
  );
  const productAppRepositoryIds = new Set(
    input.repositories
      .filter((repository) => repository.classification === "PRODUCT_APP")
      .map((repository) => repository.repoId),
  );
  return input.apps
    .filter((app) => productAppRepositoryIds.has(app.repoId))
    .map((app) => {
      const config = app.activeConfigs[0];
      const sourceSha = currentSources.get(app.repoId);
      if (
        app.activeConfigs.length !== 1
        || !config
        || typeof sourceSha !== "string"
        || !SHA.test(sourceSha)
        || !config.snapshotDigest
        || !config.snapshotSignature
        || config.activatedSnapshot === null
        || !input.verifySnapshot({
          snapshot: config.activatedSnapshot,
          digest: config.snapshotDigest,
          signature: config.snapshotSignature,
        })
      ) throw new Error("FLEET_MIGRATION_RUNTIME_SNAPSHOT_INVALID");
      return {
        repositoryId: app.repoId,
        appId: app.id,
        configRevisionId: config.id,
        sourceSha,
        snapshotDigest: config.snapshotDigest,
        snapshotSignatureDigest: createHash("sha256")
          .update(config.snapshotSignature)
          .digest("hex"),
      };
    })
    .sort((left, right) => {
      const leftId = BigInt(left.repositoryId);
      const rightId = BigInt(right.repositoryId);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}
