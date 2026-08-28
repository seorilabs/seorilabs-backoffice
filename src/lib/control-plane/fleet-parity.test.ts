import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFleetParityWave,
  FLEET_PARITY_CONTRACT_VERSION,
  FLEET_PARITY_EXPECTED_SOURCE_COUNT,
  fleetParityCohortDigest,
  type FleetParityVectorItem,
} from "@/lib/control-plane/fleet-parity";

function match(overrides: Partial<FleetParityVectorItem> = {}): FleetParityVectorItem {
  return {
    appId: "app-1",
    repoId: 123n,
    repoFullName: "seorilabs/app-1",
    sourceSha: "a".repeat(40),
    configRevisionId: "config-1",
    scope: "FULL",
    contractVersion: FLEET_PARITY_CONTRACT_VERSION,
    status: "MATCH",
    legacyDigest: "b".repeat(64),
    centralDigest: "b".repeat(64),
    sourceCount: FLEET_PARITY_EXPECTED_SOURCE_COUNT,
    reasonCode: null,
    ...overrides,
  };
}

test("서로 다른 동일 vector의 두 PASSED wave만 parity cleanup 선행조건을 연다", () => {
  const results = [match()];
  const cohortDigest = fleetParityCohortDigest(results);
  const first = evaluateFleetParityWave({ waveId: "wave-1", cohortDigest, results, previous: null });
  assert.equal(first.status, "PASSED");
  assert.equal(first.consecutiveMatchCount, 1);
  assert.equal(first.cleanupAllowed, false);

  const replay = evaluateFleetParityWave({
    waveId: "wave-1",
    cohortDigest,
    results,
    previous: {
      id: "wave-1",
      status: first.status,
      cohortDigest,
      vectorDigest: first.vectorDigest,
      consecutiveMatchCount: first.consecutiveMatchCount,
    },
  });
  assert.equal(replay.consecutiveMatchCount, 1);
  assert.equal(replay.cleanupAllowed, false);

  const second = evaluateFleetParityWave({
    waveId: "wave-2",
    cohortDigest,
    results,
    previous: {
      id: "wave-1",
      status: first.status,
      cohortDigest,
      vectorDigest: first.vectorDigest,
      consecutiveMatchCount: first.consecutiveMatchCount,
    },
  });
  assert.equal(second.status, "PASSED");
  assert.equal(second.consecutiveMatchCount, 2);
  assert.equal(second.cleanupAllowed, true);
});

test("SHA, ACTIVE revision, contract 또는 cohort가 바뀌면 연속 횟수를 1로 초기화한다", () => {
  const base = [match()];
  const cohortDigest = fleetParityCohortDigest(base);
  const first = evaluateFleetParityWave({ waveId: "wave-1", cohortDigest, results: base, previous: null });
  const previous = {
    id: "wave-1",
    status: first.status,
    cohortDigest,
    vectorDigest: first.vectorDigest,
    consecutiveMatchCount: 1,
  } as const;

  for (const results of [
    [match({ sourceSha: "c".repeat(40) })],
    [match({ configRevisionId: "config-2" })],
    [match({ contractVersion: "legacy-shadow-v999" })],
  ]) {
    const currentCohort = fleetParityCohortDigest(results);
    const evaluated = evaluateFleetParityWave({
      waveId: "wave-2",
      cohortDigest: currentCohort,
      results,
      previous,
    });
    assert.equal(evaluated.consecutiveMatchCount, results[0].contractVersion === FLEET_PARITY_CONTRACT_VERSION ? 1 : 0);
    assert.equal(evaluated.cleanupAllowed, false);
  }

  const expanded = [base[0], match({ appId: "app-2", repoId: 456n, repoFullName: "seorilabs/app-2" })];
  const evaluated = evaluateFleetParityWave({
    waveId: "wave-2",
    cohortDigest: fleetParityCohortDigest(expanded),
    results: expanded,
    previous,
  });
  assert.equal(evaluated.consecutiveMatchCount, 1);
});

test("MISMATCH, NEEDS_INPUT, 오류, 부분 source coverage와 빈 cohort는 fail-closed한다", () => {
  for (const results of [
    [match({ status: "MISMATCH" })],
    [match({ status: "NEEDS_INPUT", legacyDigest: null, centralDigest: null })],
    [match({ status: "ERROR", reasonCode: "SOURCE_VECTOR_CHANGED" })],
    [match({ sourceCount: FLEET_PARITY_EXPECTED_SOURCE_COUNT - 1 })],
    [],
  ]) {
    const evaluated = evaluateFleetParityWave({
      waveId: "wave-x",
      cohortDigest: fleetParityCohortDigest(results),
      results,
      previous: null,
    });
    assert.equal(evaluated.status, "BLOCKED");
    assert.equal(evaluated.consecutiveMatchCount, 0);
    assert.equal(evaluated.cleanupAllowed, false);
  }
});
