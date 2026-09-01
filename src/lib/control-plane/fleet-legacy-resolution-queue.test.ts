import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  chunkFleetLegacyResolutionKeys,
  projectFleetLegacyResolutionQueueItem,
} from "@/lib/control-plane/fleet-legacy-resolution-queue";

function sourceRow() {
  return {
    id: "app-1",
    repoId: 123n,
    repoFullName: "seorilabs/example-app",
    configRevisions: [{
      id: "config-1",
      revision: 7,
      marketLocalizations: [] as Array<{ id: string }>,
      complianceProfiles: [] as Array<{ id: string }>,
      storeAssets: [] as Array<{ id: string }>,
    }],
    buildTargets: [{ id: "target-1" }],
    externalBindings: [],
    providerObservations: [{ id: "provider-1" }],
    platformFleetBinding: null,
    credentialBindings: [] as Array<{ id: string }>,
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
        observedAt: new Date("2026-01-02T00:00:00.000Z"),
      }],
    }],
    legacyConfigResolutions: [{
      sourceSha: "a".repeat(40),
      transformVersion: "legacy-config-v1",
      revision: 2,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    }],
  };
}

test("중앙 legacy queue는 공개 reason과 실제 evidence만 투영한다", () => {
  const item = projectFleetLegacyResolutionQueueItem(sourceRow());
  assert.ok(item);
  assert.equal(item.reviewable, true);
  assert.equal(item.approvalReady, true);
  assert.equal(item.awaitingParity, false);
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
  assert.deepEqual(item.missingEvidenceKinds, []);
  assert.deepEqual(item.suggestedDispositions, [
    { reasonCode: "FREE_TEXT_REQUIRES_INPUT", targets: ["CONFIG_REVISION"] },
    { reasonCode: "PROVIDER_STATE_AMBIGUITY", targets: ["PROVIDER_OBSERVATION"] },
  ]);
  assert.deepEqual(Object.keys(item).sort(), [
    "activeConfigRevision",
    "appId",
    "approvalReady",
    "availableEvidenceKinds",
    "awaitingParity",
    "blockers",
    "expectedResolutionRevision",
    "importStatus",
    "legacyImportId",
    "missingEvidenceKinds",
    "parityStatus",
    "rawReasonCodes",
    "reasonCodes",
    "repoFullName",
    "repoId",
    "reviewable",
    "sourceSha",
    "suggestedDispositions",
  ]);
});

test("법적 선언과 credential 공개 증거가 없으면 검토 가능하지만 승인은 차단한다", () => {
  const row = sourceRow();
  row.legacyConfigImports[0]!.reasonCodes = [
    "LEGAL_COMPLIANCE_AMBIGUITY",
    "SECRET_LIKE_KEY",
  ];
  const blocked = projectFleetLegacyResolutionQueueItem(row);
  assert.ok(blocked);
  assert.equal(blocked.reviewable, true);
  assert.equal(blocked.approvalReady, false);
  assert.deepEqual(blocked.missingEvidenceKinds, [
    "COMPLIANCE_PROFILE",
    "CREDENTIAL_BINDING",
  ]);

  row.configRevisions[0]!.complianceProfiles = [{ id: "compliance-1" }];
  row.credentialBindings = [{ id: "credential-1" }];
  const ready = projectFleetLegacyResolutionQueueItem(row);
  assert.ok(ready);
  assert.equal(ready.approvalReady, true);
  assert.deepEqual(ready.missingEvidenceKinds, []);
});

test("이미 MATCH로 증명된 import는 중앙 처리 큐에서 제외한다", () => {
  const row = sourceRow();
  row.legacyConfigImports[0]!.parityObservations = [{
    status: "MATCH",
    legacyConfigResolutionId: "resolution-1",
    observedAt: new Date("2026-01-03T00:00:00.000Z"),
  }];
  assert.equal(projectFleetLegacyResolutionQueueItem(row), null);
});

test("새 resolution이 최신 parity보다 뒤면 중복 승인을 막고 재검증 대기로 표시한다", () => {
  const row = sourceRow();
  row.legacyConfigResolutions[0]!.createdAt = new Date("2026-01-03T00:00:00.000Z");
  const item = projectFleetLegacyResolutionQueueItem(row);

  assert.ok(item);
  assert.equal(item.reviewable, true);
  assert.equal(item.awaitingParity, true);
  assert.equal(item.approvalReady, false);
  assert.deepEqual(item.missingEvidenceKinds, []);
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
  assert.match(source, /where: \{ OR: exactKeyChunk \}/);
  assert.match(source, /_max: \{ revision: true \}/);
  assert.match(source, /legacyConfigResolution\.findMany\(\{/);
  assert.match(source, /where: \{ OR: exactLatestRevisionKeys \}/);
  assert.match(source, /revision: resolution\._max\.revision/);
  assert.doesNotMatch(source, /_max: \{ revision: true, createdAt: true \}/);
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

test("resolution exact key 조회는 앱이 늘어나도 100개 이하 query로 나눈다", () => {
  const keys = Array.from({ length: 205 }, (_, index) => `key-${index}`);
  const chunks = chunkFleetLegacyResolutionKeys(keys);

  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 5]);
  assert.deepEqual(chunks.flat(), keys);
  assert.deepEqual(chunkFleetLegacyResolutionKeys([]), []);
});
