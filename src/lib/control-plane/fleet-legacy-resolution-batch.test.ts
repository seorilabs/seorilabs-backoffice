import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  prepareFleetLegacyResolutionBatch,
  type FleetLegacyResolutionBatchSelection,
} from "@/lib/control-plane/fleet-legacy-resolution-batch";
import type { FleetLegacyResolutionQueueItem } from "@/lib/control-plane/fleet-legacy-resolution-queue";

function queueItem(overrides: Partial<FleetLegacyResolutionQueueItem> = {}): FleetLegacyResolutionQueueItem {
  return {
    appId: "app-1",
    repoId: "123",
    repoFullName: "seorilabs/example-app",
    legacyImportId: "import-1",
    sourceSha: "a".repeat(40),
    importStatus: "DRAFT_CREATED_WITH_INPUT",
    parityStatus: "NEEDS_INPUT",
    activeConfigRevision: 7,
    expectedResolutionRevision: 2,
    reasonCodes: ["FREE_TEXT_REQUIRES_INPUT", "PROVIDER_STATE_AMBIGUITY"],
    rawReasonCodes: ["FREE_TEXT_REQUIRES_INPUT", "PROVIDER_STATE_AMBIGUITY"],
    availableEvidenceKinds: ["CONFIG_REVISION", "PROVIDER_OBSERVATION"],
    suggestedDispositions: [
      { reasonCode: "FREE_TEXT_REQUIRES_INPUT", targets: ["CONFIG_REVISION"] },
      { reasonCode: "PROVIDER_STATE_AMBIGUITY", targets: ["PROVIDER_OBSERVATION"] },
    ],
    missingEvidenceKinds: [],
    reviewable: true,
    approvalReady: true,
    awaitingParity: false,
    blockers: [],
    ...overrides,
  };
}

function selection(overrides: Partial<FleetLegacyResolutionBatchSelection> = {}): FleetLegacyResolutionBatchSelection {
  return {
    appId: "app-1",
    repoId: "123",
    sourceSha: "a".repeat(40),
    legacyImportId: "import-1",
    expectedActiveConfigRevision: 7,
    expectedResolutionRevision: 2,
    requestId: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

test("일괄 승인은 화면의 exact vector를 서버가 다시 선택한 disposition에 결합한다", () => {
  const prepared = prepareFleetLegacyResolutionBatch({
    queue: [queueItem()],
    selections: [selection()],
  });

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]!.repoFullName, "seorilabs/example-app");
  assert.equal(prepared[0]!.request.repoId, 123n);
  assert.equal(prepared[0]!.request.justification, "CENTRAL_STATE_REVIEWED");
  assert.deepEqual(prepared[0]!.request.dispositions, queueItem().suggestedDispositions);
});

test("source나 ACTIVE revision이 바뀌면 일괄 mutation 전에 전체를 거부한다", () => {
  assert.throws(
    () => prepareFleetLegacyResolutionBatch({
      queue: [queueItem()],
      selections: [selection({ expectedActiveConfigRevision: 8 })],
    }),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "LEGACY_RESOLUTION_BATCH_STALE"
    ),
  );
});

test("필수 중앙 증거가 없거나 같은 import를 중복 지정하면 거부한다", () => {
  assert.throws(
    () => prepareFleetLegacyResolutionBatch({
      queue: [queueItem({
        approvalReady: false,
        missingEvidenceKinds: ["COMPLIANCE_PROFILE"],
      })],
      selections: [selection()],
    }),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "LEGACY_RESOLUTION_BATCH_EVIDENCE_MISSING"
    ),
  );

  assert.throws(
    () => prepareFleetLegacyResolutionBatch({
      queue: [queueItem()],
      selections: [selection(), selection({ requestId: "22222222-2222-4222-8222-222222222222" })],
    }),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "LEGACY_RESOLUTION_BATCH_DUPLICATE"
    ),
  );
});

test("일괄 UI는 전체 preflight 뒤 기존 개별 CAS 원장을 사용하고 비밀 입력면을 만들지 않는다", () => {
  const action = readFileSync(
    join(process.cwd(), "src/lib/actions/legacy-config-resolution.ts"),
    "utf8",
  );
  const component = readFileSync(
    join(process.cwd(), "src/components/fleet/LegacyConfigResolutionBatchButton.tsx"),
    "utf8",
  );

  assert.ok(action.indexOf("prepareFleetLegacyResolutionBatch({") < action.indexOf("for (const item of prepared)"));
  assert.match(action, /recordLegacyConfigResolution\(\{/);
  assert.match(action, /approvalKind: "HUMAN"/);
  assert.match(action, /revalidatePath\("\/settings"\)/);
  assert.match(component, /LEGACY_RESOLUTION_BATCH_LIMIT/);
  assert.doesNotMatch(component, /type="password"|secretValue|privateKey|accessToken/i);
});
