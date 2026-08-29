import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { RELEASE_CANDIDATE_REQUIRED_GATES, RELEASE_GATE_NAMES } from "@/lib/control-plane/contracts";
import { EXTERNAL_RELEASE_GATES, isExternalReleaseGate } from "@/lib/control-plane/lifecycle-policy";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("외부 단계 gate 목록은 release-candidate 필수 gate와 정확히 상보다", () => {
  assert.deepEqual([...EXTERNAL_RELEASE_GATES], [
    "UPLOAD", "PROCESSING", "DEVICE_QA", "REVIEW", "APPROVAL", "DEPLOYMENT", "PUBLIC",
  ]);
  assert.deepEqual(
    [...RELEASE_CANDIDATE_REQUIRED_GATES, ...EXTERNAL_RELEASE_GATES].sort(),
    [...RELEASE_GATE_NAMES].sort(),
  );
  for (const gate of RELEASE_CANDIDATE_REQUIRED_GATES) assert.equal(isExternalReleaseGate(gate), false);
  for (const gate of EXTERNAL_RELEASE_GATES) assert.equal(isExternalReleaseGate(gate), true);
  assert.equal(isExternalReleaseGate("SOMETHING_ELSE"), false);
});

test("gate 원장 write는 공통 helper 한 곳에만 있다", () => {
  const files = [
    "src/lib/control-plane/release-ledger.ts",
    "src/lib/control-plane/provider-execution-service.ts",
    "src/app/api/control-plane/release-gate-observations/route.ts",
  ];
  const creates = files.reduce(
    (total, path) => total + source(path).split("releaseGateObservation.create(").length - 1,
    0,
  );
  assert.equal(creates, 1, "release gate 원장에 쓰는 지점이 하나가 아니다");
  assert.match(source("src/lib/control-plane/release-ledger.ts"), /export async function appendReleaseGateObservation/);
});

test("범용 release-gate 경로는 외부 단계 gate를 write 전에 거부한다", () => {
  const ledger = source("src/lib/control-plane/release-ledger.ts");
  const externalCheck = ledger.indexOf('"EXTERNAL_GATE_PROVIDER_ONLY"');
  const identityCheck = ledger.indexOf('"GATE_IDENTITY_REQUIRED"');
  const executionBinding = ledger.indexOf('"PROVIDER_EXECUTION_BINDING_MISMATCH"');
  const observationBinding = ledger.indexOf('"PROVIDER_OBSERVATION_BINDING_MISMATCH"');
  const create = ledger.indexOf("releaseGateObservation.create(");

  assert.ok(externalCheck > 0);
  assert.ok(externalCheck < create, "외부 gate 거부가 원장 write 뒤에 있다");
  assert.ok(identityCheck > 0 && identityCheck < create);
  assert.ok(executionBinding > 0 && executionBinding < create);
  assert.ok(observationBinding > 0 && observationBinding < create);
  assert.match(ledger, /origin: \{ kind: "CANDIDATE_GATE" \}/);
  // release-candidate gate를 provider settlement로 위조하는 방향도 막는다.
  assert.match(ledger, /"CANDIDATE_GATE_PROVIDER_FORBIDDEN"/);
});

test("PROVIDER_SHELL PASSED는 exact ProjectBlueprint COMPLIANT와 서버 provenance를 요구한다", () => {
  const ledger = source("src/lib/control-plane/release-ledger.ts");
  const planReadback = ledger.indexOf("getProjectBlueprintPlanWithClient(tx");
  const compliantCheck = ledger.indexOf('plan.status !== "COMPLIANT"');
  const create = ledger.indexOf("releaseGateObservation.create(");
  assert.ok(planReadback > 0 && planReadback < create);
  assert.ok(compliantCheck > planReadback && compliantCheck < create);
  assert.match(ledger, /"PROVIDER_SHELL_NOT_COMPLIANT"/);
  assert.match(ledger, /projectBlueprint: \{/);
  assert.match(ledger, /appId: plan\.appId/);
  assert.match(ledger, /planDigest/);
  assert.match(ledger, /providerObservationIds/);

  // HTTP evidence 계약에는 provenance 자리가 없어 caller가 서버 파생 값을 주입할 수 없다.
  const contracts = source("src/lib/control-plane/contracts.ts");
  const evidenceStart = contracts.indexOf("export const releaseGateObservationSchema");
  const evidenceBlock = contracts.slice(evidenceStart, evidenceStart + 900);
  assert.doesNotMatch(evidenceBlock, /projectBlueprint|planDigest|providerObservationIds/);
});

test("provider settlement만 PROVIDER_SETTLEMENT origin을 만들고 evidence provenance는 서버가 넣는다", () => {
  const service = source("src/lib/control-plane/provider-execution-service.ts");
  assert.match(service, /appendReleaseGateObservation\(\{/);
  assert.match(service, /kind: "PROVIDER_SETTLEMENT"/);
  assert.match(service, /executionId: execution\.id/);
  assert.match(service, /observationId: observation\.id/);
  assert.match(service, /publicAccountId: execution\.publicAccountId/);
  assert.match(service, /publicAppId: execution\.resourceId/);
  assert.match(service, /bindingHash: execution\.bindingHash/);

  const ledger = source("src/lib/control-plane/release-ledger.ts");
  assert.match(ledger, /providerExecutionId: execution\.id/);
  assert.match(ledger, /providerObservationId: providerObservation\.id/);

  // HTTP 요청 계약에는 provenance 필드가 없어 호출자가 주입할 수 없다.
  const contracts = source("src/lib/control-plane/contracts.ts");
  const evidenceStart = contracts.indexOf("export const releaseGateObservationSchema");
  const evidenceBlock = contracts.slice(evidenceStart, evidenceStart + 900);
  assert.doesNotMatch(evidenceBlock, /providerExecutionId|providerObservationId/);

  const route = source("src/app/api/control-plane/release-gate-observations/route.ts");
  assert.doesNotMatch(route, /PROVIDER_SETTLEMENT|providerExecutionId/);
});

test("provider settlement 통합 계약이 CI 신규 DB 시나리오에서 실행된다", () => {
  const bootstrap = source("scripts/test-migration-bootstrap.sh");
  assert.match(bootstrap, /scripts\/test-project-blueprint-release-ledger\.ts/);

  const integration = source("scripts/test-project-blueprint-release-ledger.ts");
  assert.match(integration, /_contract_test/);
  assert.match(integration, /EXTERNAL_GATE_PROVIDER_ONLY/);
  assert.match(integration, /STALE_LEASE/);
  assert.match(integration, /PROVIDER_IDENTITY_MISMATCH/);
  assert.match(integration, /CANDIDATE_BINDING_MISMATCH/);
  assert.match(integration, /BLUEPRINT_NOT_CONFIGURED/);
  assert.match(integration, /PROVIDER_SHELL_NOT_COMPLIANT/);
  assert.match(integration, /engine: "GODOT"/);
  assert.match(integration, /concurrentProviderShell/);
  assert.match(integration, /assert\.equal\(replayedSettlement\.duplicate, true\)/);
  assert.match(integration, /assert\.equal\(final\.stage, "MONITORED"\)/);
});
