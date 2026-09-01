import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { projectFleetLegacyResolutionQueueItem } from "@/lib/control-plane/fleet-legacy-resolution-queue";

function sourceRow() {
  return {
    id: "app-1",
    repoId: 123n,
    repoFullName: "seorilabs/example-app",
    configRevisions: [{
      id: "config-1",
      revision: 7,
      marketLocalizations: [],
      complianceProfiles: [],
      storeAssets: [],
    }],
    buildTargets: [{ id: "target-1" }],
    externalBindings: [],
    providerObservations: [{ id: "provider-1" }],
    platformFleetBinding: null,
    credentialBindings: [],
    automationDefinitions: [],
    legacyConfigImports: [{
      id: "import-1",
      sourceSha: "a".repeat(40),
      transformVersion: "legacy-config-v1",
      reasonCodes: ["FREE_TEXT_REQUIRES_INPUT", "PROVIDER_STATE_AMBIGUITY"],
      status: "DRAFT_CREATED_WITH_INPUT",
      parityObservations: [{
        status: "NEEDS_INPUT",
        legacyConfigResolutionId: null as string | null,
      }],
    }],
    legacyConfigResolutions: [{
      sourceSha: "a".repeat(40),
      transformVersion: "legacy-config-v1",
      revision: 2,
    }],
  };
}

test("중앙 legacy queue는 공개 reason과 실제 evidence만 투영한다", () => {
  const item = projectFleetLegacyResolutionQueueItem(sourceRow());
  assert.ok(item);
  assert.equal(item.reviewable, true);
  assert.equal(item.activeConfigRevision, 7);
  assert.equal(item.expectedResolutionRevision, 2);
  assert.deepEqual(item.reasonCodes, [
    "FREE_TEXT_REQUIRES_INPUT",
    "PROVIDER_STATE_AMBIGUITY",
  ]);
  assert.deepEqual(item.availableEvidenceKinds, [
    "CONFIG_REVISION",
    "BUILD_TARGET",
    "PROVIDER_OBSERVATION",
  ]);
});

test("이미 MATCH로 증명된 import는 중앙 처리 큐에서 제외한다", () => {
  const row = sourceRow();
  row.legacyConfigImports[0]!.parityObservations = [{
    status: "MATCH",
    legacyConfigResolutionId: "resolution-1",
  }];
  assert.equal(projectFleetLegacyResolutionQueueItem(row), null);
});

test("검토 불가능한 import와 지원하지 않는 reason은 선행 조치로 분리한다", () => {
  const row = sourceRow();
  row.configRevisions = [];
  row.legacyConfigImports[0]!.status = "NEEDS_INPUT";
  row.legacyConfigImports[0]!.reasonCodes = ["INVALID_DESIRED_STATE"];
  const item = projectFleetLegacyResolutionQueueItem(row);
  assert.ok(item);
  assert.equal(item.reviewable, false);
  assert.deepEqual(item.blockers, [
    "IMPORT_NOT_REVIEWABLE",
    "ACTIVE_CONFIG_MISSING",
    "REASON_LEDGER_INVALID",
  ]);
  assert.deepEqual(item.rawReasonCodes, ["INVALID_DESIRED_STATE"]);
});

test("중앙 queue 조회는 exact source tuple의 최신 resolution과 존재 여부만 읽는다", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/control-plane/fleet-legacy-resolution-queue.ts"),
    "utf8",
  );
  assert.match(source, /legacyConfigResolution\.groupBy\(\{/);
  assert.match(source, /by: \["appId", "sourceSha", "transformVersion"\]/);
  assert.doesNotMatch(source, /legacyConfigResolutions:\s*\{[\s\S]*?take:\s*100/);
  for (const relation of [
    "marketLocalizations",
    "complianceProfiles",
    "storeAssets",
    "buildTargets",
    "externalBindings",
  ]) {
    assert.match(source, new RegExp(`${relation}: \\{ take: 1, select:`));
  }
});
