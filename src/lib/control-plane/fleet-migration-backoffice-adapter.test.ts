import assert from "node:assert/strict";
import test from "node:test";

import {
  createFleetMigrationBackofficeAdapter,
  fleetMigrationConfigSourceMatchesDiscovery,
  fleetMigrationPlatformFleetBindingEvidence,
  fleetMigrationProofDigest,
  publicFleetMigrationProviderObservations,
  stableFleetMigrationBackofficeStateDigest,
} from "@/lib/control-plane/fleet-migration-backoffice-adapter";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const SOURCE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const DETECTOR_SHA = "c".repeat(40);
const BLOB_INVENTORY_DIGEST = `sha256:${"d".repeat(64)}`;
const READINESS_DIGEST = "e".repeat(64);
const READINESS_COHORT_DIGEST = "f".repeat(64);
const CANDIDATES: JsonValue[] = [];
const CANDIDATES_DIGEST = `sha256:${jsonDigest(CANDIDATES)}`;
const STABLE_DIGEST = stableFleetMigrationBackofficeStateDigest({
  classification: "INFRA_REPO",
  classificationDecisionRevision: 7,
  classificationDecisionId: "classification-decision-0001",
  app: null,
  activeConfig: null,
  signedSnapshot: null,
  platformFleetBinding: null,
  providerObservations: [],
  credentialBindings: [],
});
const PROOF_DIGEST = fleetMigrationProofDigest({
  repositoryId: "101",
  repositoryFullName: "seorilabs/infra",
  sourceSha: SOURCE_SHA,
  treeSha: TREE_SHA,
  blobInventoryDigest: BLOB_INVENTORY_DIGEST,
  detectorSourceSha: DETECTOR_SHA,
  readinessEvidenceDigest: READINESS_DIGEST,
  readinessCohortDigest: READINESS_COHORT_DIGEST,
  stableBackofficeStateDigest: STABLE_DIGEST,
  candidatesDigest: CANDIDATES_DIGEST,
});

function fixtureClient(proofPresent = true) {
  const approvalAttestation = { contract: "public-proof-approval-v1", state: "APPROVED" };
  const registration = {
    repoId: 101n,
    repoFullName: "seorilabs/infra",
    defaultBranch: "main",
    classification: "INFRA_REPO",
    classificationDecisionVersion: 7,
    classificationDecisions: [{ id: "classification-decision-0001", revision: 7, classification: "INFRA_REPO" }],
  };
  return {
    repositoryRegistration: {
      async findUnique(input: { where: { repoId?: bigint; repoFullName?: string } }) {
        return input.where.repoFullName === "seorilabs/platform" ? { repoId: 999n } : registration;
      },
    },
    app: { async findUnique() { return null; } },
    fleetMigrationProofSnapshot: {
      async findFirst() {
        return proofPresent ? {
          id: "proof-snapshot-0001",
          repositoryId: 101n,
          repositoryFullName: "seorilabs/infra",
          sourceSha: SOURCE_SHA,
          treeSha: TREE_SHA,
          blobInventoryDigest: BLOB_INVENTORY_DIGEST,
          detectorSourceSha: DETECTOR_SHA,
          readinessEvidenceDigest: READINESS_DIGEST,
          readinessCohortDigest: READINESS_COHORT_DIGEST,
          stableBackofficeStateDigest: STABLE_DIGEST,
          candidates: CANDIDATES,
          candidatesDigest: CANDIDATES_DIGEST,
          proofDigest: PROOF_DIGEST,
          approvalAttestation,
          approvalAttestationDigest: jsonDigest(approvalAttestation),
          observedAt: new Date("2026-08-30T00:00:00.000Z"),
          createdAt: new Date("2026-08-30T00:00:00.000Z"),
        } : null;
      },
    },
  };
}

function adapter(proofPresent = true) {
  return createFleetMigrationBackofficeAdapter({
    detectorSourceSha: DETECTOR_SHA,
    readinessEvidenceDigest: READINESS_DIGEST,
    readinessCohortDigest: READINESS_COHORT_DIGEST,
    snapshotSigningKeyId: "control-plane-snapshot-v1",
    snapshotPolicyRevision: "snapshot-policy-v1",
    approvedProofDigests: [PROOF_DIGEST],
    client: fixtureClient(proofPresent) as never,
    now: () => new Date("2026-08-30T00:00:01.000Z"),
  });
}

function request() {
  return {
    contract: "seorilabs-fleet-migration-backoffice-public-evidence-v3",
    organizationId: "283115031",
    repositoryId: "101",
    fullName: "seorilabs/infra",
    sourceRef: "refs/heads/main",
    sourceSha: SOURCE_SHA,
    treeSha: TREE_SHA,
    blobInventoryDigest: BLOB_INVENTORY_DIGEST,
    detections: [],
  };
}

test("Backoffice adapter returns exact-source evidence only from an approved immutable proof", async () => {
  const result = await adapter().readBackofficePublicEvidence(request());
  assert.equal(result.publicEvidence.repositoryId, "101");
  assert.equal(result.publicEvidence.sourceSha, SOURCE_SHA);
  assert.equal(result.publicEvidence.classification, "INFRA_REPO");
  assert.deepEqual(result.candidates, []);
  assert.doesNotMatch(JSON.stringify(result), /token|secretValue|privateKey/iu);
});

test("missing or unapproved proof snapshot fails closed", async () => {
  await assert.rejects(
    adapter(false).readBackofficePublicEvidence(request()),
    /FLEET_MIGRATION_PROOF_SNAPSHOT_MISSING_OR_STALE/,
  );
  const unapproved = createFleetMigrationBackofficeAdapter({
    detectorSourceSha: DETECTOR_SHA,
    readinessEvidenceDigest: READINESS_DIGEST,
    readinessCohortDigest: READINESS_COHORT_DIGEST,
    snapshotSigningKeyId: "control-plane-snapshot-v1",
    snapshotPolicyRevision: "snapshot-policy-v1",
    approvedProofDigests: [],
    client: fixtureClient() as never,
  });
  await assert.rejects(
    unapproved.readBackofficePublicEvidence(request()),
    /FLEET_MIGRATION_PROOF_SNAPSHOT_MISSING_OR_STALE/,
  );
});

function observation(input: { id: string; desiredHash: string; observedAt: Date }) {
  const payload = {
    schemaVersion: 1 as const,
    visibility: "VISIBLE" as const,
    state: "PRESENT" as const,
    publicIdentity: "projects/example-project",
    attributes: { desiredHash: input.desiredHash },
  };
  return {
    id: input.id,
    provider: "gcp",
    resourceType: "project",
    resourceId: "example-project",
    payload,
    payloadHash: jsonDigest(payload),
    observedAt: input.observedAt,
    createdAt: input.observedAt,
  };
}

function execution(input: {
  id: string;
  desiredHash: string;
  observationId: string | null;
  createdAt: Date;
  completedAt?: Date | null;
  status?: string;
}) {
  return {
    id: input.id,
    provider: "gcp",
    resourceType: "project",
    resourceId: "example-project",
    sourceSha: SOURCE_SHA,
    configRevisionId: "config-revision-0001",
    desiredHash: input.desiredHash,
    expectedPublicIdentity: "projects/example-project",
    lastObservationId: input.observationId,
    status: input.status ?? "SUCCEEDED",
    leaseGeneration: 1,
    completedAt: input.completedAt === undefined ? input.createdAt : input.completedAt,
    createdAt: input.createdAt,
  };
}

function desired(desiredHash: string) {
  return [{
    provider: "gcp" as const,
    resourceType: "project",
    resourceId: "example-project",
    desiredHash,
    desired: {} as JsonValue,
    publicIdentity: "projects/example-project",
  }];
}

test("provider state uses the newest execution per resource and never revives an older compliant row", () => {
  const olderAt = new Date("2026-08-30T00:00:00.000Z");
  const newerAt = new Date("2026-08-30T00:01:00.000Z");
  const rows = [
    observation({ id: "provider-observation-old", desiredHash: "a".repeat(64), observedAt: olderAt }),
    observation({ id: "provider-observation-new", desiredHash: "b".repeat(64), observedAt: newerAt }),
  ];
  assert.throws(() => publicFleetMigrationProviderObservations({
    rows,
    executions: [
      execution({ id: "provider-execution-old", desiredHash: "a".repeat(64), observationId: rows[0]!.id, createdAt: olderAt }),
      execution({ id: "provider-execution-new", desiredHash: "c".repeat(64), observationId: rows[1]!.id, createdAt: newerAt }),
    ],
    desiredResources: desired("c".repeat(64)),
    sourceSha: SOURCE_SHA,
    configRevisionId: "config-revision-0001",
  }), /FLEET_MIGRATION_PROVIDER_LATEST_STATE_DRIFT/);
});

test("newest non-terminal provider execution fails closed even when an older row is compliant", () => {
  const olderAt = new Date("2026-08-30T00:00:00.000Z");
  const newerAt = new Date("2026-08-30T00:01:00.000Z");
  const row = observation({ id: "provider-observation-old", desiredHash: "a".repeat(64), observedAt: olderAt });
  assert.throws(() => publicFleetMigrationProviderObservations({
    rows: [row],
    executions: [
      execution({ id: "provider-execution-old", desiredHash: "a".repeat(64), observationId: row.id, createdAt: olderAt }),
      execution({ id: "provider-execution-new", desiredHash: "a".repeat(64), observationId: null, createdAt: newerAt, completedAt: null, status: "RUNNING" }),
    ],
    desiredResources: desired("a".repeat(64)),
    sourceSha: SOURCE_SHA,
    configRevisionId: "config-revision-0001",
  }), /FLEET_MIGRATION_PROVIDER_OBSERVATION_PROVENANCE_INVALID/);
});

test("provider execution은 ACTIVE blueprint의 전체 exact resource set을 덮어야 한다", () => {
  const observedAt = new Date("2026-08-30T00:00:00.000Z");
  const row = observation({ id: "provider-observation-current", desiredHash: "a".repeat(64), observedAt });
  assert.throws(() => publicFleetMigrationProviderObservations({
    rows: [row],
    executions: [],
    desiredResources: desired("a".repeat(64)),
    sourceSha: SOURCE_SHA,
    configRevisionId: "config-revision-0001",
  }), /FLEET_MIGRATION_PROVIDER_EXECUTION_COVERAGE_INCOMPLETE/);

  assert.throws(() => publicFleetMigrationProviderObservations({
    rows: [row],
    executions: [execution({
      id: "provider-execution-current",
      desiredHash: "b".repeat(64),
      observationId: row.id,
      createdAt: observedAt,
    })],
    desiredResources: desired("a".repeat(64)),
    sourceSha: SOURCE_SHA,
    configRevisionId: "config-revision-0001",
  }), /FLEET_MIGRATION_PROVIDER_OBSERVATION_PROVENANCE_INVALID/);
});

test("승인본 판본 상태를 그대로 기록하고 미연결은 null로 남긴다", () => {
  // 이관 전 실태 기록이 목적이므로 수렴 여부로 기록을 막지 않는다. 대신 어떤 상태였고
  // 어느 커밋 기준이었는지를 남겨야 나중에 각 저장소가 이 기록을 근거로 따라올 수 있다.
  const release = { sourceSha: "1".repeat(40), manifestDigest: "2".repeat(64) };
  const common = {
    appId: "app-product-0001",
    platformAppId: "registry-app-product-0001",
    platformRepositoryId: "999",
    observedSourceSha: "3".repeat(40),
  };

  const compliant = fleetMigrationPlatformFleetBindingEvidence({
    ...common,
    binding: {
      id: "binding-0001",
      state: "COMPLIANT",
      sourceSha: "3".repeat(40),
      platformRelease: release,
    },
  });
  assert.equal(compliant?.compliance, "COMPLIANT");
  assert.equal(compliant?.complianceDetail, "COMPLIANT");
  assert.equal(compliant?.appSourceSha, "3".repeat(40));
  assert.equal(compliant?.state, "ACTIVE");

  const divergent = fleetMigrationPlatformFleetBindingEvidence({
    ...common,
    binding: {
      id: "binding-0001",
      state: "UPDATE_PR_QUEUED",
      sourceSha: "3".repeat(40),
      platformRelease: release,
    },
  });
  assert.equal(divergent?.compliance, "DIVERGENT");
  assert.equal(divergent?.complianceDetail, "UPDATE_PR_QUEUED");

  // 계약이 모르는 새 내부 상태가 생겨도 DIVERGENT로 접히고 원문은 detail에 남는다.
  const unknownState = fleetMigrationPlatformFleetBindingEvidence({
    ...common,
    binding: {
      id: "binding-0001",
      state: "AHEAD_UNMANAGED_REMEDIATION_ISSUE_OPEN",
      sourceSha: "3".repeat(40),
      platformRelease: release,
    },
  });
  assert.equal(unknownState?.compliance, "DIVERGENT");
  assert.equal(unknownState?.complianceDetail, "AHEAD_UNMANAGED_REMEDIATION_ISSUE_OPEN");

  // 같은 상태라도 판본이 다르면 digest가 갈린다. 기록이 실제 내용에 결박돼 있다는 뜻이다.
  const otherRelease = fleetMigrationPlatformFleetBindingEvidence({
    ...common,
    binding: {
      id: "binding-0001",
      state: "COMPLIANT",
      sourceSha: "3".repeat(40),
      platformRelease: { sourceSha: "4".repeat(40), manifestDigest: release.manifestDigest },
    },
  });
  assert.notEqual(compliant?.digest, otherRelease?.digest);

  // 지금 관측 중인 커밋에서 잰 상태면 current, 뒤처졌으면 그 사실이 기록에 드러난다.
  assert.equal(compliant?.appSourceCurrent, true);
  const staleMeasurement = fleetMigrationPlatformFleetBindingEvidence({
    ...common,
    binding: {
      id: "binding-0001",
      state: "COMPLIANT",
      sourceSha: "5".repeat(40),
      platformRelease: release,
    },
  });
  assert.equal(staleMeasurement?.appSourceCurrent, false);
  assert.equal(staleMeasurement?.appSourceSha, "5".repeat(40));

  assert.equal(
    fleetMigrationPlatformFleetBindingEvidence({ ...common, binding: null }),
    null,
  );
  // Platform 원장 미등록은 연결 부재와 다른 사실이다. 연결은 남기고 식별자만 null로 적는다.
  const unregistered = fleetMigrationPlatformFleetBindingEvidence({
    ...common,
    platformAppId: null,
    binding: {
      id: "binding-0001",
      state: "COMPLIANT",
      sourceSha: "3".repeat(40),
      platformRelease: release,
    },
  });
  assert.notEqual(unregistered, null);
  assert.equal(unregistered?.platformAppId, null);
  assert.equal(unregistered?.compliance, "COMPLIANT");

  // 어느 커밋에서 잰 상태인지 알 수 없으면 기술할 대상이 없다.
  assert.equal(
    fleetMigrationPlatformFleetBindingEvidence({
      ...common,
      binding: {
        id: "binding-0001",
        state: "COMPLIANT",
        sourceSha: null,
        platformRelease: release,
      },
    }),
    null,
  );
  assert.equal(
    fleetMigrationPlatformFleetBindingEvidence({
      ...common,
      binding: { id: "binding-0001", state: "COMPLIANT", sourceSha: null, platformRelease: null },
    }),
    null,
  );
});

test("재탐지 관측은 같은 source로 보되 source가 다르면 잡는다", () => {
  // 같은 커밋을 같은 payload로 다시 탐지하면 DiscoveryObservation row가 새로 생긴다.
  // 실측 22곳 중 11곳이 이 상태였다. row id 일치를 요구하면 재탐지 한 번에 진단과 기록이
  // 갈리므로 source 자체로 판정한다. readiness가 같은 함수를 쓴다.
  const source = { sourceSha: "a".repeat(40), payloadHash: "b".repeat(64) };

  // 다른 row지만 같은 source — 재탐지다.
  assert.equal(
    fleetMigrationConfigSourceMatchesDiscovery(source, { ...source }),
    true,
  );

  // source가 다르면 잡는다. row id 지름길을 두면 이 경우가 새어 나간다.
  assert.equal(
    fleetMigrationConfigSourceMatchesDiscovery(source, { ...source, sourceSha: "c".repeat(40) }),
    false,
  );
  assert.equal(
    fleetMigrationConfigSourceMatchesDiscovery(source, { ...source, payloadHash: "d".repeat(64) }),
    false,
  );

  // 한쪽이 없으면 비교할 대상이 없다.
  assert.equal(fleetMigrationConfigSourceMatchesDiscovery(null, source), false);
  assert.equal(fleetMigrationConfigSourceMatchesDiscovery(source, undefined), false);
});

test("readiness와 공개 증거는 config source 판정도 공유한다", async () => {
  const { readFileSync } = await import("node:fs");
  const readiness = readFileSync(
    new URL("./fleet-migration-shadow-readiness.ts", import.meta.url),
    "utf8",
  );
  const adapter = readFileSync(
    new URL("./fleet-migration-backoffice-adapter.ts", import.meta.url),
    "utf8",
  );

  assert.match(adapter, /export function fleetMigrationConfigSourceMatchesDiscovery/u);
  assert.match(readiness, /fleetMigrationConfigSourceMatchesDiscovery\(/u);
  assert.match(adapter, /fleetMigrationConfigSourceMatchesDiscovery\(\s*config\?\.sourceObservation/u);

  // 반증: 어느 한쪽이 자체 비교로 되돌아가면 잡힌다.
  assert.doesNotMatch(readiness, /sourceObservation\.payloadHash !== latestDiscovery\.payloadHash/u);
  assert.doesNotMatch(adapter, /config\.sourceObservationId !== discovery\.id/u);
});

test("ProjectBlueprint가 없으면 provider 상태를 비운 채 기록한다", async () => {
  // blueprint는 P5 산출물이라 실측 22곳 중 20곳에 없고, 그 20곳은 provider 실행 기록도
  // 0건이다. 증명된 provider 상태가 없으므로 빈 목록이 유일하게 정직한 기록이다.
  const { readFileSync } = await import("node:fs");
  const adapter = readFileSync(
    new URL("./fleet-migration-backoffice-adapter.ts", import.meta.url),
    "utf8",
  );

  assert.match(adapter, /providerObservations = blueprint\.success\s*\?/u);
  assert.match(adapter, /:\s*\[\];/u);
  // 반증: blueprint 부재가 다시 전체 증거 실패 조건으로 돌아가면 잡힌다.
  assert.doesNotMatch(adapter, /\|\| !blueprint\.success/u);

  // 빈 desired set으로 투영을 부르면 계속 fail-closed다. 그래서 호출 자체를 건너뛴다.
  assert.throws(
    () => publicFleetMigrationProviderObservations({
      rows: [],
      executions: [],
      desiredResources: [],
      sourceSha: "a".repeat(40),
      configRevisionId: "config-0001",
    }),
    /FLEET_MIGRATION_PROVIDER_DESIRED_RESOURCE_SET_INVALID/u,
  );
});
