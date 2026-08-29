import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { projectDiscoveryConfigPayload } from "@/lib/control-plane/config-revision-discovery-projection";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  assertConfigRevisionReplay,
  assertCurrentConfigSourceBinding,
  assertExpectedLatestConfigRevision,
  CONFIG_REVISION_DISCOVERY_PROJECTION_CONTRACT_VERSION,
  CONFIG_REVISION_MANUAL_SOURCE_CONTRACT_VERSION,
  CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION,
  ControlPlaneError,
} from "@/lib/control-plane/service";

const REPO_ID = 1_250_442_131n;
const SOURCE_SHA = "a".repeat(40);

function sourceFixture() {
  const payload: Record<string, unknown> = {
    schemaVersion: 2,
    contractVersion: "repository-discovery/v8",
    repository: {
      id: Number(REPO_ID),
      fullName: "seorilabs/happy-farm",
      sourceSha: SOURCE_SHA,
      sourceRef: "refs/heads/main",
    },
    status: "ACTIVE",
    classification: "PRODUCT_APP",
  };
  return {
    app: {
      id: "app-happy-farm",
      repoId: REPO_ID,
      repoFullName: "seorilabs/happy-farm",
      status: "ACTIVE",
    },
    registration: {
      repoId: REPO_ID,
      repoFullName: "seorilabs/happy-farm",
      defaultBranch: "main",
      archived: false,
      status: "MANAGED",
      classification: "PRODUCT_APP",
      discoveryContractVersion: "repository-discovery/v8",
      lastDefaultPushSha: SOURCE_SHA,
      lastReconciledSha: SOURCE_SHA,
    },
    observation: {
      id: "discovery-happy-farm-v8",
      appId: "app-happy-farm",
      sourceSha: SOURCE_SHA,
      sourceRef: "refs/heads/main",
      payload,
      payloadHash: jsonDigest(payload as JsonValue),
      requestHash: "b".repeat(64),
    },
  };
}

function replayFixture(contractVersion = CONFIG_REVISION_SOURCE_REBASE_CONTRACT_VERSION) {
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

test("MANAGED PRODUCT_APP의 exact main discovery만 ConfigRevision source가 된다", () => {
  assert.doesNotThrow(() => assertCurrentConfigSourceBinding(sourceFixture()));
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
      stored: replayFixture(CONFIG_REVISION_MANUAL_SOURCE_CONTRACT_VERSION),
      repoId: REPO_ID,
      actor: "operator:seorilabs",
      expectedLatestRevision: 7,
      contractVersion: CONFIG_REVISION_MANUAL_SOURCE_CONTRACT_VERSION,
      payloadHash: "f".repeat(64),
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

test("rebase와 legacy projection은 append-only audit만 남기고 activation을 분리한다", () => {
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
});
