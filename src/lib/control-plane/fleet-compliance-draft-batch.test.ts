import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  prepareFleetComplianceDraftBatch,
  type FleetComplianceDraftBatchSelection,
} from "@/lib/control-plane/fleet-compliance-draft-batch";
import type { FleetComplianceDraftQueueState } from "@/lib/control-plane/fleet-compliance-draft-queue";

function queue(overrides: Partial<FleetComplianceDraftQueueState> = {}): FleetComplianceDraftQueueState {
  return {
    appId: "app-1",
    appSlug: "example-app",
    repoId: "123",
    repoFullName: "seorilabs/example-app",
    sourceSha: "a".repeat(40),
    activeConfigRevision: 7,
    latestConfigRevision: 7,
    enabledMarkets: ["app-store", "google-play"],
    reasonCodes: ["LEGAL_COMPLIANCE_AMBIGUITY"],
    credentialBindingRequired: false,
    eligible: true,
    blockers: [],
    activePayload: {
      schemaVersion: 1,
      markets: [
        { market: "google-play", enabled: true, locales: [], releaseChannel: "internal" },
        { market: "app-store", enabled: true, locales: [], releaseChannel: "testflight" },
      ],
      support: { privacyPolicyUrl: "https://example.com/privacy" },
    },
    latestRevisionState: {
      revision: 7,
      status: "ACTIVE",
      idempotencyKey: "active-revision",
      payloadHash: "b".repeat(64),
    },
    ...overrides,
  };
}

function selection(overrides: Partial<FleetComplianceDraftBatchSelection> = {}): FleetComplianceDraftBatchSelection {
  return {
    appId: "app-1",
    repoId: "123",
    sourceSha: "a".repeat(40),
    expectedActiveConfigRevision: 7,
    expectedLatestConfigRevision: 7,
    requestId: "11111111-1111-4111-8111-111111111111",
    complianceDrafts: [
      {
        market: "app-store",
        declaration: "privacy",
        state: "DRAFT",
        draft: "App Store 개인정보 처리 초안 검토 완료",
      },
      {
        market: "google-play",
        declaration: "data-safety",
        state: "DRAFT",
        draft: "Google Play 데이터 보안 초안 검토 완료",
      },
    ],
    ...overrides,
  };
}

test("Compliance batch는 ACTIVE payload를 보존하고 enabled market 초안만 추가한다", () => {
  const prepared = prepareFleetComplianceDraftBatch({
    queue: [queue()],
    selections: [selection()],
  });

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]!.mode, "CREATE");
  assert.equal(prepared[0]!.expectedLatestConfigRevision, 7);
  assert.deepEqual(prepared[0]!.payload.support, { privacyPolicyUrl: "https://example.com/privacy" });
  assert.deepEqual(
    (prepared[0]!.payload.complianceDrafts as Array<{ market: string }>).map((draft) => draft.market),
    ["app-store", "google-play"],
  );
});

test("legacy shadow DRAFT 뒤에는 실제 latest revision에서 새 Compliance revision을 만든다", () => {
  const prepared = prepareFleetComplianceDraftBatch({
    queue: [queue({
      latestConfigRevision: 14,
      latestRevisionState: {
        revision: 14,
        status: "DRAFT",
        idempotencyKey: "legacy-shadow-draft:generated",
        payloadHash: "c".repeat(64),
      },
    })],
    selections: [selection({ expectedLatestConfigRevision: 14 })],
  });

  assert.equal(prepared[0]!.mode, "CREATE");
  assert.equal(prepared[0]!.expectedActiveConfigRevision, 7);
  assert.equal(prepared[0]!.expectedLatestConfigRevision, 14);
});

test("enabled market 누락과 credential 후보가 있는 초안은 mutation 전에 거부한다", () => {
  assert.throws(
    () => prepareFleetComplianceDraftBatch({
      queue: [queue()],
      selections: [selection({ complianceDrafts: [selection().complianceDrafts[0]!] })],
    }),
    (error: unknown) => error instanceof Error && "code" in error
      && error.code === "FLEET_COMPLIANCE_MARKET_COVERAGE_MISSING",
  );

  assert.throws(
    () => prepareFleetComplianceDraftBatch({
      queue: [queue()],
      selections: [selection({
        complianceDrafts: selection().complianceDrafts.map((draft) => ({
          ...draft,
          draft: "password=credential-canary-value",
        })),
      })],
    }),
    /credential 후보/,
  );

  assert.throws(
    () => prepareFleetComplianceDraftBatch({
      queue: [queue()],
      selections: [selection({
        complianceDrafts: selection().complianceDrafts.map((draft) => ({
          ...draft,
          draft: { apiKey: "abcd" },
        })),
      })],
    }),
    /credential 후보/,
  );
});

test("같은 request의 생성 완료 DRAFT만 idempotent activation 재개를 허용한다", () => {
  const initial = prepareFleetComplianceDraftBatch({
    queue: [queue()],
    selections: [selection()],
  })[0]!;
  const resumed = prepareFleetComplianceDraftBatch({
    queue: [queue({
      latestConfigRevision: 8,
      eligible: false,
      blockers: ["LATEST_DRAFT_EXISTS"],
      latestRevisionState: {
        revision: 8,
        status: "DRAFT",
        idempotencyKey: `ui-compliance-batch-create:${selection().requestId}`,
        payloadHash: initial.payloadHash,
      },
    })],
    selections: [selection({ expectedLatestConfigRevision: 8 })],
  });

  assert.equal(resumed[0]!.mode, "RESUME");
  assert.equal(resumed[0]!.expectedLatestConfigRevision, 7);

  const resumedAfterLegacyBacklog = prepareFleetComplianceDraftBatch({
    queue: [queue({
      latestConfigRevision: 15,
      eligible: false,
      blockers: ["LATEST_DRAFT_EXISTS"],
      latestRevisionState: {
        revision: 15,
        status: "DRAFT",
        idempotencyKey: `ui-compliance-batch-create:${selection().requestId}`,
        payloadHash: initial.payloadHash,
      },
    })],
    selections: [selection({ expectedLatestConfigRevision: 15 })],
  });

  assert.equal(resumedAfterLegacyBacklog[0]!.mode, "RESUME");
  assert.equal(resumedAfterLegacyBacklog[0]!.expectedLatestConfigRevision, 14);

  assert.throws(
    () => prepareFleetComplianceDraftBatch({
      queue: [queue({
        latestConfigRevision: 8,
        eligible: false,
        blockers: ["LATEST_DRAFT_EXISTS"],
        latestRevisionState: {
          revision: 8,
          status: "DRAFT",
          idempotencyKey: "unrelated-draft",
          payloadHash: initial.payloadHash,
        },
      })],
      selections: [selection()],
    }),
    (error: unknown) => error instanceof Error && "code" in error
      && error.code === "FLEET_COMPLIANCE_BATCH_NOT_ELIGIBLE",
  );
});

test("server action은 exact source 생성, signed activation, 단계별 결과를 사용한다", () => {
  const action = readFileSync(
    join(process.cwd(), "src/lib/actions/fleet-compliance-draft.ts"),
    "utf8",
  );
  const component = readFileSync(
    join(process.cwd(), "src/components/fleet/FleetComplianceDraftBatch.tsx"),
    "utf8",
  );

  assert.ok(action.indexOf("prepareFleetComplianceDraftBatch({") < action.indexOf("createConfigRevision({"));
  assert.match(action, /expectedSourceSha: item\.sourceSha/);
  assert.match(action, /activateConfigRevision\(\{/);
  assert.match(action, /CONTROL_PLANE_SNAPSHOT_SIGNING_KEY/);
  assert.match(action, /stage: "CREATE"/);
  assert.match(action, /stage: "ACTIVATE"/);
  assert.doesNotMatch(action, /provider.*submit|public.*release/i);
  assert.doesNotMatch(component, /type="password"|secretValue|privateKey|accessToken/i);
  assert.match(component, /selected\.size >= FLEET_COMPLIANCE_DRAFT_BATCH_LIMIT/);
  assert.match(component, /selectedItems\.length >= FLEET_COMPLIANCE_DRAFT_BATCH_LIMIT/);
});
