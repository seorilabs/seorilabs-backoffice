import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { LEGACY_SOURCE_DEFINITIONS, LEGACY_TRANSFORM_VERSION } from "@/lib/control-plane/legacy-sources";

export const FLEET_PARITY_SCOPE = "FULL";
export const FLEET_PARITY_CONTRACT_VERSION = LEGACY_TRANSFORM_VERSION;
export const FLEET_PARITY_EXPECTED_SOURCE_COUNT = LEGACY_SOURCE_DEFINITIONS.length;

export type FleetParityResultState =
  | "PENDING"
  | "MATCH"
  | "MISMATCH"
  | "NEEDS_INPUT"
  | "ERROR";

export type FleetParityVectorItem = {
  appId: string;
  repoId: bigint | string;
  repoFullName: string;
  sourceSha: string | null;
  configRevisionId: string | null;
  scope: string;
  contractVersion: string;
  status: FleetParityResultState;
  legacyDigest: string | null;
  centralDigest: string | null;
  sourceCount: number;
  reasonCode?: string | null;
};

export type PreviousFleetParityWave = {
  id: string;
  status: "RUNNING" | "PASSED" | "BLOCKED";
  cohortDigest: string;
  vectorDigest: string | null;
  consecutiveMatchCount: number;
};

function ordered(items: readonly FleetParityVectorItem[]) {
  return [...items].sort((left, right) => (
    `${left.repoId.toString()}:${left.appId}`.localeCompare(`${right.repoId.toString()}:${right.appId}`)
  ));
}

export function fleetParityCohortDigest(items: readonly FleetParityVectorItem[]): string {
  return jsonDigest(ordered(items).map((item) => ({
    appId: item.appId,
    repoId: item.repoId.toString(),
    repoFullName: item.repoFullName.toLowerCase(),
    sourceSha: item.sourceSha,
    configRevisionId: item.configRevisionId,
    scope: item.scope,
    contractVersion: item.contractVersion,
  })) as JsonValue);
}

export function fleetParityVectorDigest(items: readonly FleetParityVectorItem[]): string {
  return jsonDigest(ordered(items).map((item) => ({
    appId: item.appId,
    repoId: item.repoId.toString(),
    sourceSha: item.sourceSha,
    configRevisionId: item.configRevisionId,
    scope: item.scope,
    contractVersion: item.contractVersion,
    status: item.status,
    legacyDigest: item.legacyDigest,
    centralDigest: item.centralDigest,
    sourceCount: item.sourceCount,
    reasonCode: item.reasonCode ?? null,
  })) as JsonValue);
}

function isFullMatch(item: FleetParityVectorItem): boolean {
  return item.status === "MATCH"
    && item.scope === FLEET_PARITY_SCOPE
    && item.contractVersion === FLEET_PARITY_CONTRACT_VERSION
    && item.sourceSha !== null
    && item.configRevisionId !== null
    && item.legacyDigest !== null
    && item.legacyDigest === item.centralDigest
    && item.sourceCount === FLEET_PARITY_EXPECTED_SOURCE_COUNT;
}

export function evaluateFleetParityWave(input: {
  waveId: string;
  cohortDigest: string;
  results: readonly FleetParityVectorItem[];
  previous: PreviousFleetParityWave | null;
}) {
  const vectorDigest = fleetParityVectorDigest(input.results);
  const matchCount = input.results.filter(isFullMatch).length;
  const passed = input.results.length > 0 && matchCount === input.results.length;
  const previous = input.previous;
  const previousContinues = passed
    && previous !== null
    && previous.id !== input.waveId
    && previous.status === "PASSED"
    && previous.cohortDigest === input.cohortDigest
    && previous.vectorDigest === vectorDigest;
  const consecutiveMatchCount = passed
    ? previousContinues
      ? previous.consecutiveMatchCount + 1
      : 1
    : 0;
  return {
    status: passed ? "PASSED" as const : "BLOCKED" as const,
    vectorDigest,
    matchCount,
    consecutiveMatchCount,
    // 이 값은 legacy parity 선행조건만 뜻한다. restore/build-only gate를 대신하지 않는다.
    cleanupAllowed: consecutiveMatchCount >= 2,
  };
}
