import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { repositoryClassificationDecisionSchema } from "@/lib/control-plane/contracts";
import {
  repositoryClassificationCandidates,
} from "@/lib/control-plane/repository-classification-decision";
import {
  drainRepositoryDiscoveryQueue,
} from "@/lib/control-plane/repository-discovery-service";
import { ControlPlaneError } from "@/lib/control-plane/service";

test("분류 API와 사람 UI는 같은 strict validator와 transaction service를 사용한다", () => {
  const valid = repositoryClassificationDecisionSchema.parse({
    schemaVersion: 1,
    repoId: "42",
    expectedGeneration: 3,
    expectedDecisionRevision: 1,
    classification: "PRODUCT_APP",
    candidateMarkerPath: "apps/mobile/package.json",
    justification: "APP_CANDIDATE_SELECTED",
  });
  assert.equal(valid.repoId, 42n);
  assert.equal(repositoryClassificationDecisionSchema.safeParse({
    ...valid,
    classification: "EXCLUDED",
    candidateMarkerPath: "apps/mobile/package.json",
  }).success, false);

  const root = process.cwd();
  const api = readFileSync(join(root, "src/app/api/control-plane/repository-classification-decisions/route.ts"), "utf8");
  const action = readFileSync(join(root, "src/lib/actions/repository-classification.ts"), "utf8");
  const service = readFileSync(join(root, "src/lib/control-plane/repository-classification-decision.ts"), "utf8");
  const discoveryService = readFileSync(join(root, "src/lib/control-plane/repository-discovery-service.ts"), "utf8");
  for (const source of [api, action]) {
    assert.match(source, /repositoryClassificationDecisionSchema\.parse/);
    assert.match(source, /recordRepositoryClassificationDecision/);
  }
  assert.match(service, /FOR UPDATE/);
  assert.match(service, /classificationDecisionVersion/);
  assert.match(service, /control-plane\.repository-classification\.decided/);
  assert.doesNotMatch(service, /deleteMany|\.delete\(|\.update\(\{\s*where:\s*\{\s*id: decision/);
  assert.match(discoveryService, /classificationDecision\?\.revision \?\? 0/);
  assert.match(discoveryService, /REPOSITORY_CLASSIFICATION_REVISION_STALE/);
});

test("UI에는 exact observation에서 검증된 공개 candidate marker만 노출한다", () => {
  assert.deepEqual(repositoryClassificationCandidates({ candidates: [
    { profile: "godot", workingDirectory: "game", markerPath: "game/project.godot" },
    { profile: "react-native", workingDirectory: "apps/mobile", markerPath: "apps/mobile/package.json" },
    { profile: "react-native", workingDirectory: "unsafe", markerPath: "../package.json" },
    { profile: "unknown", workingDirectory: ".", markerPath: "package.json" },
  ] }), [
    { profile: "react-native", workingDirectory: "apps/mobile", markerPath: "apps/mobile/package.json" },
    { profile: "godot", workingDirectory: "game", markerPath: "game/project.godot" },
  ]);
});

function drainClient(sequence: Array<Array<{
  status: "REGISTERED" | "NEEDS_INPUT" | "MANAGED" | "ARCHIVED";
  reconcileGeneration: number | null;
  discoveryRuns: Array<{
    generation: number;
    status: "QUEUED" | "RUNNING" | "MANAGED" | "NEEDS_INPUT" | "EXCLUDED" | "STALE" | "FAILED";
  }>;
}>>) {
  let index = 0;
  return {
    repositoryRegistration: {
      async findMany() {
        const value = sequence[Math.min(index, sequence.length - 1)];
        index++;
        return value;
      },
    },
  };
}

test("drain은 enqueue를 claim한 뒤 terminal readback을 두 번 확인한다", async () => {
  const events: string[] = [];
  const queued = [{
    status: "REGISTERED" as const,
    reconcileGeneration: 1,
    discoveryRuns: [{ generation: 1, status: "QUEUED" as const }],
  }];
  const settled = [{
    status: "MANAGED" as const,
    reconcileGeneration: 1,
    discoveryRuns: [{ generation: 1, status: "MANAGED" as const }],
  }];
  let now = 0;
  const result = await drainRepositoryDiscoveryQueue({
    workerId: "test:drain",
    timeoutMs: 1_000,
    pollIntervalMs: 10,
  }, {
    client: drainClient([queued, settled, settled]) as never,
    runOnce: async () => {
      events.push("claim");
      return { claimed: true };
    },
    now: () => new Date(now),
    wait: async (milliseconds) => { now += milliseconds; events.push("readback"); },
  });
  assert.equal(result.claimed, 1);
  assert.deepEqual(events, ["claim", "readback", "readback"]);
});

test("drain은 FAILED와 reenqueue 없이 남은 STALE을 성공으로 숨기지 않는다", async () => {
  const failed = [{
    status: "NEEDS_INPUT" as const,
    reconcileGeneration: 1,
    discoveryRuns: [{ generation: 1, status: "FAILED" as const }],
  }];
  await assert.rejects(drainRepositoryDiscoveryQueue({
    workerId: "test:failed",
    timeoutMs: 100,
    pollIntervalMs: 10,
  }, {
    client: drainClient([failed]) as never,
    runOnce: async () => ({ claimed: false }),
    now: () => new Date(0),
    wait: async () => undefined,
  }), (error) => error instanceof ControlPlaneError && error.code === "REPOSITORY_DISCOVERY_DRAIN_FAILED");

  let now = 0;
  const stale = [{
    status: "NEEDS_INPUT" as const,
    reconcileGeneration: 1,
    discoveryRuns: [{ generation: 1, status: "STALE" as const }],
  }];
  await assert.rejects(drainRepositoryDiscoveryQueue({
    workerId: "test:stale",
    timeoutMs: 20,
    pollIntervalMs: 10,
  }, {
    client: drainClient([stale]) as never,
    runOnce: async () => ({ claimed: false }),
    now: () => new Date(now),
    wait: async (milliseconds) => { now += milliseconds; },
  }), (error) => error instanceof ControlPlaneError && error.code === "REPOSITORY_DISCOVERY_DRAIN_TIMEOUT");
});
