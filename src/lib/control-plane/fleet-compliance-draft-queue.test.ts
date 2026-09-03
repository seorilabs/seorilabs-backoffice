import assert from "node:assert/strict";
import test from "node:test";

import {
  projectFleetComplianceDraftQueueItem,
  publicFleetComplianceDraftQueueItem,
} from "@/lib/control-plane/fleet-compliance-draft-queue";
import type { FleetLegacyResolutionQueueItem } from "@/lib/control-plane/fleet-legacy-resolution-queue";

function legacy(overrides: Partial<FleetLegacyResolutionQueueItem> = {}): FleetLegacyResolutionQueueItem {
  return {
    appId: "app-1",
    repoId: "123",
    repoFullName: "seorilabs/example-app",
    legacyImportId: "import-1",
    sourceSha: "a".repeat(40),
    importStatus: "DRAFT_CREATED_WITH_INPUT",
    parityStatus: "NEEDS_INPUT",
    activeConfigRevision: 7,
    expectedResolutionRevision: 0,
    reasonCodes: ["LEGAL_COMPLIANCE_AMBIGUITY"],
    rawReasonCodes: ["LEGAL_COMPLIANCE_AMBIGUITY"],
    availableEvidenceKinds: ["CONFIG_REVISION"],
    suggestedDispositions: [{ reasonCode: "LEGAL_COMPLIANCE_AMBIGUITY", targets: [] }],
    missingEvidenceKinds: ["COMPLIANCE_PROFILE"],
    reviewable: true,
    approvalReady: false,
    awaitingParity: false,
    blockers: [],
    ...overrides,
  };
}

function app(payload: Record<string, unknown> = {
  schemaVersion: 1,
  markets: [
    { market: "google-play", enabled: true, locales: [], releaseChannel: "internal" },
    { market: "app-store", enabled: true, locales: [], releaseChannel: "testflight" },
  ],
}) {
  return {
    id: "app-1",
    slug: "example-app",
    repoId: 123n,
    repoFullName: "seorilabs/example-app",
    configRevisions: [{ revision: 7, payload, complianceProfiles: [] }],
    discoveryObservations: [{ sourceSha: "a".repeat(40) }],
  };
}

function latest(revision = 7) {
  return {
    appId: "app-1",
    revision,
    status: revision === 7 ? "ACTIVE" : "DRAFT",
    idempotencyKey: revision === 7 ? "active-revision" : "unrelated-draft",
    payloadHash: "b".repeat(64),
  };
}

test("Compliance 중앙 queue는 enabled market과 exact source/revision만 공개한다", () => {
  const item = projectFleetComplianceDraftQueueItem({
    legacy: legacy(),
    app: app(),
    latestRevision: latest(),
  });

  assert.equal(item.eligible, true);
  assert.deepEqual(item.enabledMarkets, ["app-store", "google-play"]);
  assert.equal(item.credentialBindingRequired, false);
  assert.deepEqual(item.blockers, []);
});

test("기존 DRAFT, source drift, projection drift는 중앙 activation을 fail-closed한다", () => {
  const pending = projectFleetComplianceDraftQueueItem({
    legacy: legacy(),
    app: {
      ...app({
        schemaVersion: 1,
        markets: [{ market: "google-play", enabled: true, locales: [], releaseChannel: "internal" }],
        complianceDrafts: [{
          market: "google-play",
          declaration: "privacy",
          state: "DRAFT",
          draft: "reviewed",
        }],
      }),
      discoveryObservations: [{ sourceSha: "c".repeat(40) }],
    },
    latestRevision: latest(8),
    pendingNonLegacyDraftRevisions: [8],
  });

  assert.equal(pending.eligible, false);
  assert.deepEqual(pending.blockers, [
    "ACTIVE_COMPLIANCE_PROJECTION_DRIFT",
    "SOURCE_SHA_CHANGED",
    "LATEST_DRAFT_EXISTS",
  ]);
});

test("legacy shadow가 만든 DRAFT만 최신이면 사람 Compliance 입력을 막지 않는다", () => {
  const item = projectFleetComplianceDraftQueueItem({
    legacy: legacy(),
    app: app(),
    latestRevision: {
      ...latest(14),
      idempotencyKey: "legacy-shadow-draft:generated",
    },
    pendingNonLegacyDraftRevisions: [],
  });

  assert.equal(item.eligible, true);
  assert.equal(item.latestConfigRevision, 14);
  assert.deepEqual(item.blockers, []);
});

test("ACTIVE가 없으면 missing만 보고 revision changed를 중복 표시하지 않는다", () => {
  const missing = projectFleetComplianceDraftQueueItem({
    legacy: legacy({ activeConfigRevision: null }),
    app: { ...app(), configRevisions: [] },
    latestRevision: null,
  });

  assert.equal(missing.eligible, false);
  assert.ok(missing.blockers.includes("ACTIVE_CONFIG_MISSING"));
  assert.ok(!missing.blockers.includes("ACTIVE_REVISION_CHANGED"));
});

test("Settings client에는 ACTIVE payload와 내부 idempotency state를 전달하지 않는다", () => {
  const projected = projectFleetComplianceDraftQueueItem({
    legacy: legacy(),
    app: app(),
    latestRevision: latest(),
  });
  assert.deepEqual(Object.keys(publicFleetComplianceDraftQueueItem(projected)).sort(), [
    "activeConfigRevision",
    "appId",
    "blockers",
    "credentialBindingRequired",
    "eligible",
    "enabledMarkets",
    "latestConfigRevision",
    "reasonCodes",
    "repoFullName",
    "repoId",
    "sourceSha",
  ]);
});
