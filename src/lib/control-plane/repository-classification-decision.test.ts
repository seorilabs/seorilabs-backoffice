import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { repositoryClassificationDecisionSchema } from "@/lib/control-plane/contracts";
import {
  repositoryClassificationCandidates,
  validateCurrentRepositoryClassificationRatification,
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
  assert.match(service, /control-plane\.repository-classification\.ratified/);
  assert.doesNotMatch(service, /deleteMany|\.delete\(|\.update\(\{\s*where:\s*\{\s*id: decision/);
  assert.match(discoveryService, /classificationDecision\?\.revision \?\? 0/);
  assert.match(discoveryService, /REPOSITORY_CLASSIFICATION_REVISION_STALE/);
});

function ratificationEvidence() {
  const sourceSha = "a".repeat(40);
  const candidates = [{
    profile: "react-native" as const,
    workingDirectory: "apps/mobile",
    markerPath: "apps/mobile/package.json",
  }];
  return {
    expectedGeneration: 6,
    expectedDecisionRevision: 0,
    classification: "PRODUCT_APP" as const,
    candidateMarkerPath: "apps/mobile/package.json",
    registration: {
      classification: "PRODUCT_APP" as const,
      discoveryContractVersion: "repository-discovery/v6",
      discoveryCandidates: {
        contractVersion: "repository-discovery/v6",
        sourceSha,
        reasonCode: null,
        classification: "PRODUCT_APP",
        candidates,
      },
      lastDefaultPushSha: sourceSha,
      lastReconciledSha: sourceSha,
      reconcileGeneration: 6,
    },
    latestDecision: null,
    terminalRun: {
      id: "run-current",
      generation: 6,
      sourceSha,
      status: "MANAGED" as const,
      classification: "PRODUCT_APP" as const,
      contractVersion: "repository-discovery/v6",
      candidateDigest: "54412bd5c6f0216c5b6a6373f9312d1bb15b3c31cc134c4b48ad317a010c53ba",
      observationId: "observation-current",
      completedAt: new Date("2026-08-29T00:00:00.000Z"),
    },
  };
}

test("MANAGED ratification은 exact terminal source, contract, candidate를 묶고 discovery를 재실행하지 않는다", () => {
  const request = repositoryClassificationDecisionSchema.parse({
    schemaVersion: 1,
    repoId: "42",
    expectedGeneration: 6,
    expectedDecisionRevision: 0,
    classification: "PRODUCT_APP",
    candidateMarkerPath: "apps/mobile/package.json",
    justification: "CURRENT_OBSERVATION_RATIFIED",
  });
  assert.equal(request.justification, "CURRENT_OBSERVATION_RATIFIED");

  const result = validateCurrentRepositoryClassificationRatification(ratificationEvidence());
  assert.equal(result.terminalRunId, "run-current");
  assert.equal(result.candidateDigest, ratificationEvidence().terminalRun.candidateDigest);

  const service = readFileSync(
    join(process.cwd(), "src/lib/control-plane/repository-classification-decision.ts"),
    "utf8",
  );
  assert.match(service, /discoveryEnqueued: false/);
  assert.match(service, /if \(ratificationEvidence\)[\s\S]+runId: null,[\s\S]+generation: null/);
});

test("비제품 MANAGED repository는 terminal EXCLUDED 관측만 ratify한다", () => {
  const product = ratificationEvidence();
  const evidence = {
    ...product,
    classification: "INFRA_REPO" as const,
    candidateMarkerPath: null,
    registration: {
      ...product.registration,
      classification: "INFRA_REPO" as const,
      discoveryCandidates: {
        contractVersion: "repository-discovery/v6",
        sourceSha: product.registration.lastReconciledSha,
        reasonCode: "INFRASTRUCTURE_REPOSITORY",
        classification: "INFRA_REPO",
        candidates: [],
      },
    },
    terminalRun: {
      ...product.terminalRun,
      status: "EXCLUDED" as const,
      classification: "INFRA_REPO" as const,
      candidateDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      observationId: null,
    },
  };
  assert.equal(
    validateCurrentRepositoryClassificationRatification(evidence).terminalRunId,
    "run-current",
  );
});

test("MANAGED ratification은 source drift, candidate drift와 기존 decision을 fail-closed한다", () => {
  const sourceDrift = ratificationEvidence();
  sourceDrift.terminalRun.sourceSha = "b".repeat(40);
  assert.throws(
    () => validateCurrentRepositoryClassificationRatification(sourceDrift),
    (error) => error instanceof ControlPlaneError
      && error.code === "REPOSITORY_CLASSIFICATION_RATIFICATION_EVIDENCE_STALE",
  );

  const candidateDrift = ratificationEvidence();
  candidateDrift.candidateMarkerPath = "package.json";
  assert.throws(
    () => validateCurrentRepositoryClassificationRatification(candidateDrift),
    (error) => error instanceof ControlPlaneError
      && error.code === "REPOSITORY_CLASSIFICATION_RATIFICATION_CANDIDATE_INVALID",
  );

  const existing = {
    ...ratificationEvidence(),
    latestDecision: { revision: 1 },
  };
  assert.throws(
    () => validateCurrentRepositoryClassificationRatification(existing),
    (error) => error instanceof ControlPlaneError
      && error.code === "REPOSITORY_CLASSIFICATION_RATIFICATION_DECISION_EXISTS",
  );
});

test("UI에는 exact observation에서 검증된 공개 candidate marker만 노출한다", () => {
  assert.deepEqual(repositoryClassificationCandidates({ candidates: [
    { profile: "godot", workingDirectory: "game", markerPath: "game/project.godot" },
    { profile: "react-native", workingDirectory: "apps/mobile", markerPath: "apps/mobile/package.json" },
    { profile: "react-native", workingDirectory: "unsafe", markerPath: "../package.json" },
    { profile: "capacitor", workingDirectory: "app", markerPath: "app/package.json" },
    { profile: "ait-web", workingDirectory: "apps-in-toss", markerPath: "apps-in-toss/package.json" },
    { profile: "unknown", workingDirectory: ".", markerPath: "package.json" },
  ] }), [
    { profile: "capacitor", workingDirectory: "app", markerPath: "app/package.json" },
    { profile: "ait-web", workingDirectory: "apps-in-toss", markerPath: "apps-in-toss/package.json" },
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
