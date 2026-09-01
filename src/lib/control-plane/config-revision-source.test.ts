import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { projectDiscoveryConfigPayload } from "@/lib/control-plane/config-revision-discovery-projection";
import { configRevisionDiscoveryDraftSchema } from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  assessConfigSourceAutoRebaseSafety,
  assertConfigRevisionReplay,
  assertConfigRevisionRebaseSource,
  assertCurrentConfigSourceBinding,
  assertManagedProductConfigSourceBinding,
  assertExpectedConfigSourceSha,
  assertExpectedLatestConfigRevision,
  configSourceBindingsMatch,
  CONFIG_REVISION_DISCOVERY_PROJECTION_CONTRACT_VERSION,
  CONFIG_REVISION_SOURCE_AUTO_REBASE_CONTRACT_VERSION,
  CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION,
  ControlPlaneError,
  isLegacyDiscoveryProjectionSource,
  resolveDiscoveryProjectionSource,
} from "@/lib/control-plane/service";

const REPO_ID = 1_250_442_131n;
const SOURCE_SHA = "a".repeat(40);

function sourceFixture(
  appStatus: "ACTIVE" | "PAUSED" | "DEPRECATED" = "ACTIVE",
  defaultBranch = "main",
) {
  const sourceRef = `refs/heads/${defaultBranch}`;
  const payload: Record<string, unknown> = {
    schemaVersion: 2,
    contractVersion: "repository-discovery/v11",
    repository: {
      id: Number(REPO_ID),
      fullName: "seorilabs/happy-farm",
      sourceSha: SOURCE_SHA,
      sourceRef,
    },
    status: "ACTIVE",
    classification: "PRODUCT_APP",
  };
  return {
    app: {
      id: "app-happy-farm",
      repoId: REPO_ID,
      repoFullName: "seorilabs/happy-farm",
      status: appStatus,
    },
    registration: {
      repoId: REPO_ID,
      repoFullName: "seorilabs/happy-farm",
      defaultBranch,
      archived: false,
      status: "MANAGED",
      classification: "PRODUCT_APP",
      discoveryContractVersion: "repository-discovery/v11",
      lastDefaultPushSha: SOURCE_SHA,
      lastReconciledSha: SOURCE_SHA,
    },
    observation: {
      id: "discovery-happy-farm-v10",
      appId: "app-happy-farm",
      sourceSha: SOURCE_SHA,
      sourceRef,
      payload,
      payloadHash: jsonDigest(payload as JsonValue),
      requestHash: "b".repeat(64),
    },
  };
}

function replayFixture(contractVersion: string | null = CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION) {
  const source = sourceFixture();
  const payload: Record<string, unknown> = { schemaVersion: 1, markets: [] };
  return {
    revision: 8,
    appId: source.app.id,
    sourceObservationId: source.observation.id,
    payload,
    payloadHash: jsonDigest(payload as JsonValue),
    createdBy: "operator:seorilabs",
    backfillContractVersion: contractVersion,
    app: { id: source.app.id, repoId: REPO_ID },
    sourceObservation: source.observation,
  };
}

test("MANAGED PRODUCT_APP의 exact registered default branch discovery만 ConfigRevision source가 된다", () => {
  assert.doesNotThrow(() => assertCurrentConfigSourceBinding(sourceFixture()));
  assert.doesNotThrow(() => assertCurrentConfigSourceBinding(sourceFixture("ACTIVE", "develop")));
});

test("중앙 managed product 경로는 PAUSED/DEPRECATED의 exact source를 읽을 수 있다", () => {
  for (const status of ["PAUSED", "DEPRECATED"] as const) {
    const fixture = sourceFixture(status);
    assert.throws(
      () => assertCurrentConfigSourceBinding(fixture),
      (error) => error instanceof ControlPlaneError && error.code === "CONFIG_SOURCE_NOT_CURRENT",
    );
    assert.doesNotThrow(() => assertManagedProductConfigSourceBinding(fixture));
    assert.deepEqual(resolveDiscoveryProjectionSource({
      appStatus: status,
      actualLatestRevision: 0,
      legacyImportCount: 0,
      fromRevision: null,
    }), { kind: "EMPTY_CONFIG" });
  }
});

test("중앙 managed product 경로도 archived/non-product/source drift는 거부한다", () => {
  const archived = sourceFixture("PAUSED");
  archived.registration.archived = true;
  archived.registration.status = "ARCHIVED";
  const nonProduct = sourceFixture("DEPRECATED");
  nonProduct.registration.classification = "INFRA_REPO";
  const stale = sourceFixture("PAUSED");
  stale.registration.lastReconciledSha = "c".repeat(40);
  for (const fixture of [archived, nonProduct, stale]) {
    assert.throws(
      () => assertManagedProductConfigSourceBinding(fixture),
      (error) => error instanceof ControlPlaneError && error.code === "CONFIG_SOURCE_NOT_CURRENT",
    );
  }
});

test("revision 0 projection은 legacy import나 기존 revision이 있으면 fail-closed한다", () => {
  for (const input of [
    {
      appStatus: "PAUSED" as const,
      actualLatestRevision: 0,
      legacyImportCount: 1,
      fromRevision: null,
    },
    {
      appStatus: "DEPRECATED" as const,
      actualLatestRevision: 1,
      legacyImportCount: 0,
      fromRevision: null,
    },
  ]) {
    assert.throws(
      () => resolveDiscoveryProjectionSource(input),
      (error) => error instanceof ControlPlaneError && error.code === "DISCOVERY_PROJECTION_NOT_ALLOWED",
    );
  }
});

test("discovery projection 요청은 DRAFT_ONLY를 명시해야 한다", () => {
  assert.equal(configRevisionDiscoveryDraftSchema.safeParse({
    repoId: REPO_ID,
    expectedLatestRevision: 0,
  }).success, false);
  assert.equal(configRevisionDiscoveryDraftSchema.safeParse({
    repoId: REPO_ID,
    expectedLatestRevision: 0,
    mode: "DRAFT_ONLY",
  }).success, true);
});

test("source app identity와 ref drift를 fail-closed한다", () => {
  const wrongApp = sourceFixture();
  wrongApp.observation.appId = "app-other";
  assert.throws(
    () => assertCurrentConfigSourceBinding(wrongApp),
    (error) => error instanceof ControlPlaneError && error.code === "CONFIG_SOURCE_PROVENANCE_INVALID",
  );
  const wrongRef = sourceFixture();
  wrongRef.observation.sourceRef = "refs/heads/release";
  assert.throws(
    () => assertCurrentConfigSourceBinding(wrongRef),
    (error) => error instanceof ControlPlaneError && error.code === "CONFIG_SOURCE_PROVENANCE_INVALID",
  );
});

test("registration SHA와 discovery SHA drift를 fail-closed한다", () => {
  const fixture = sourceFixture();
  fixture.registration.lastDefaultPushSha = "c".repeat(40);
  assert.throws(
    () => assertCurrentConfigSourceBinding(fixture),
    (error) => error instanceof ControlPlaneError && error.code === "CONFIG_SOURCE_NOT_CURRENT",
  );
});

test("discovery payload와 digest drift를 fail-closed한다", () => {
  const fixture = sourceFixture();
  fixture.observation.payload = { ...fixture.observation.payload, status: "NEEDS_INPUT" };
  assert.throws(
    () => assertCurrentConfigSourceBinding(fixture),
    (error) => error instanceof ControlPlaneError && error.code === "CONFIG_SOURCE_PROVENANCE_INVALID",
  );
});

test("create/rebase는 latest revision optimistic concurrency를 강제한다", () => {
  assert.doesNotThrow(() => assertExpectedLatestConfigRevision({
    expectedLatestRevision: 7,
    actualLatestRevision: 7,
  }));
  assert.throws(
    () => assertExpectedLatestConfigRevision({ expectedLatestRevision: 6, actualLatestRevision: 7 }),
    (error) => error instanceof ControlPlaneError && error.code === "REVISION_CONFLICT",
  );
});

test("사람 batch create는 current discovery의 exact source SHA를 강제한다", () => {
  assert.doesNotThrow(() => assertExpectedConfigSourceSha({
    expectedSourceSha: SOURCE_SHA,
    actualSourceSha: SOURCE_SHA,
  }));
  assert.doesNotThrow(() => assertExpectedConfigSourceSha({ actualSourceSha: SOURCE_SHA }));
  assert.throws(
    () => assertExpectedConfigSourceSha({
      expectedSourceSha: SOURCE_SHA,
      actualSourceSha: "b".repeat(40),
    }),
    (error) => error instanceof ControlPlaneError && error.code === "CONFIG_SOURCE_SHA_MISMATCH",
  );
});

test("rebase replay는 repo, actor, expected revision, operation 전체 충돌을 거부한다", () => {
  const stored = replayFixture();
  assert.doesNotThrow(() => assertConfigRevisionReplay({
    stored,
    repoId: REPO_ID,
    actor: "operator:seorilabs",
    expectedLatestRevision: 7,
    contractVersion: CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION,
  }));
  for (const requested of [
    { repoId: 42n, actor: "operator:seorilabs", expectedLatestRevision: 7 },
    { repoId: REPO_ID, actor: "operator:other", expectedLatestRevision: 7 },
    { repoId: REPO_ID, actor: "operator:seorilabs", expectedLatestRevision: 6 },
  ]) {
    assert.throws(
      () => assertConfigRevisionReplay({
        stored,
        ...requested,
        contractVersion: CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION,
      }),
      (error) => error instanceof ControlPlaneError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  }
});

test("manual create replay는 payload 충돌을 거부한다", () => {
  assert.throws(
    () => assertConfigRevisionReplay({
      stored: replayFixture(null),
      repoId: REPO_ID,
      actor: "operator:seorilabs",
      expectedLatestRevision: 7,
      contractVersion: null,
      payloadHash: "f".repeat(64),
    }),
    (error) => error instanceof ControlPlaneError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.throws(
    () => assertConfigRevisionReplay({
      stored: replayFixture(null),
      repoId: REPO_ID,
      actor: "operator:seorilabs",
      expectedLatestRevision: 7,
      contractVersion: null,
      expectedSourceSha: "b".repeat(40),
    }),
    (error) => error instanceof ControlPlaneError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("legacy recovery는 exact-SHA market만 투영하고 사람 입력 필드를 비운다", () => {
  const payload = projectDiscoveryConfigPayload({
    sourceSha: SOURCE_SHA,
    buildTargets: [
      { market: "apps-in-toss", observedSha: SOURCE_SHA },
      { market: "google-play", observedSha: SOURCE_SHA },
      { market: "app-store", observedSha: "c".repeat(40) },
    ],
  });
  assert.deepEqual(payload, {
    schemaVersion: 1,
    markets: [
      { market: "google-play", enabled: true, locales: [], releaseChannel: "internal" },
      { market: "apps-in-toss", enabled: true, locales: [], releaseChannel: "private" },
    ],
  });
  for (const field of [
    "projectBlueprint",
    "localizations",
    "complianceDrafts",
    "assets",
    "support",
    "build",
  ]) {
    assert.equal(Object.hasOwn(payload!, field), false);
  }
});

test("legacy projection replay는 clone과 다른 contract를 요구한다", () => {
  assert.doesNotThrow(() => assertConfigRevisionReplay({
    stored: replayFixture(CONFIG_REVISION_DISCOVERY_PROJECTION_CONTRACT_VERSION),
    repoId: REPO_ID,
    actor: "operator:seorilabs",
    expectedLatestRevision: 7,
    contractVersion: CONFIG_REVISION_DISCOVERY_PROJECTION_CONTRACT_VERSION,
  }));
});

test("일반 rebase는 legacy DRAFT를 거부하고 semantic source가 같으면 row ID가 달라도 current다", () => {
  assert.throws(
    () => assertConfigRevisionRebaseSource({
      status: "DRAFT",
      idempotencyKey: "legacy-shadow-draft:example",
      legacyConfigImport: { id: "legacy-import-1" },
    }),
    (error) => error instanceof ControlPlaneError && error.code === "CONFIG_REVISION_NOT_REBASABLE",
  );
  const left = sourceFixture().observation;
  const right = { ...sourceFixture().observation, id: "same-facts-new-row" };
  assert.equal(configSourceBindingsMatch(left, right), true);
  assert.equal(configSourceBindingsMatch(left, { ...right, payloadHash: "f".repeat(64) }), false);
});

test("source-only 자동 활성화는 payload 전체와 exact-SHA market 집합이 모두 같아야 한다", () => {
  const activePayload = {
    schemaVersion: 1,
    markets: [{
      market: "google-play",
      enabled: true,
      locales: ["ko-KR"],
      releaseChannel: "internal",
    }],
    complianceDrafts: [{
      market: "google-play",
      declaration: "data-safety",
      state: "DRAFT",
      draft: true,
    }],
  };
  assert.equal(assessConfigSourceAutoRebaseSafety({
    sourceSha: SOURCE_SHA,
    activePayload,
    desiredPayload: structuredClone(activePayload),
    buildTargets: [{ market: "google-play", observedSha: SOURCE_SHA }],
  }), null);
  assert.equal(assessConfigSourceAutoRebaseSafety({
    sourceSha: SOURCE_SHA,
    activePayload,
    desiredPayload: {
      ...activePayload,
      complianceDrafts: [{
        market: "google-play",
        declaration: "data-safety",
        state: "DRAFT",
        draft: false,
      }],
    },
    buildTargets: [{ market: "google-play", observedSha: SOURCE_SHA }],
  }), "DESIRED_PAYLOAD_CHANGED");
  for (const buildTargets of [
    [{ market: "google-play", observedSha: "c".repeat(40) }],
    [
      { market: "google-play", observedSha: SOURCE_SHA },
      { market: "google-play", observedSha: SOURCE_SHA },
    ],
    [
      { market: "google-play", observedSha: SOURCE_SHA },
      { market: "app-store", observedSha: SOURCE_SHA },
    ],
  ]) {
    assert.equal(assessConfigSourceAutoRebaseSafety({
      sourceSha: SOURCE_SHA,
      activePayload,
      desiredPayload: activePayload,
      buildTargets,
    }), "BUILD_TARGET_MARKET_CHANGED");
  }
  assert.equal(
    CONFIG_REVISION_SOURCE_AUTO_REBASE_CONTRACT_VERSION,
    "config-revision-source-auto-rebase/v1",
  );
});

test("legacy discovery projection은 exact import relation과 parity evidence를 모두 요구한다", () => {
  const evidence = {
    revisionId: "revision-1",
    status: "DRAFT",
    idempotencyKey: "legacy-shadow-draft:example",
    legacyConfigImport: {
      id: "legacy-import-1",
      configRevisionId: "revision-1",
      status: "DRAFT_CREATED_WITH_INPUT",
      transformVersion: "legacy-config-shadow/v3",
      parityObservations: [{
        id: "parity-1",
        status: "NEEDS_INPUT",
        contractVersion: "legacy-config-shadow/v3",
      }],
    },
  };
  assert.equal(isLegacyDiscoveryProjectionSource(evidence), true);
  assert.equal(isLegacyDiscoveryProjectionSource({
    ...evidence,
    legacyConfigImport: { ...evidence.legacyConfigImport, parityObservations: [] },
  }), false);
  assert.equal(isLegacyDiscoveryProjectionSource({
    ...evidence,
    legacyConfigImport: { ...evidence.legacyConfigImport, configRevisionId: "revision-other" },
  }), false);
  assert.equal(resolveDiscoveryProjectionSource({
    appStatus: "ACTIVE",
    actualLatestRevision: 1,
    legacyImportCount: 1,
    fromRevision: evidence,
  }).kind, "LEGACY_IMPORT");
});

test("수동 rebase와 legacy projection은 activation을 분리하고 중앙 safe rebase만 원자 활성화한다", () => {
  const service = readFileSync(join(process.cwd(), "src/lib/control-plane/service.ts"), "utf8");
  const rebaseRoute = readFileSync(
    join(process.cwd(), "src/app/api/control-plane/config-revisions/rebase/route.ts"),
    "utf8",
  );
  const projectionRoute = readFileSync(
    join(process.cwd(), "src/app/api/control-plane/config-revisions/discovery-draft/route.ts"),
    "utf8",
  );
  assert.match(service, /action: "control-plane\.config\.source-rebased"/);
  assert.match(service, /action: "control-plane\.config\.discovery-projected"/);
  assert.match(service, /legacyPayloadCopied: false,[\s\S]*activationAttempted: false/);
  assert.doesNotMatch(rebaseRoute, /activateConfigRevision/);
  assert.doesNotMatch(projectionRoute, /activateConfigRevision/);
  assert.match(service, /action: "control-plane\.config\.source-auto-activated"/);
  assert.match(service, /legalOrComplianceChanged: false/);
  assert.match(service, /providerMutationAttempted: false/);
});
