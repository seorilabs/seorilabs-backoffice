import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { fleetProjectionBindingDisposition } from "@/lib/control-plane/fleet-projector-binding";

test("Fleet projection은 조직 단일 Project target과 revision이 정확히 같을 때만 write 가능하다", () => {
  assert.deepEqual(fleetProjectionBindingDisposition({
    projectNodeId: "PVT_current",
    bindingRevision: 3,
    source: { kind: "CURRENT", projectNodeId: "PVT_current", bindingRevision: 3 },
  }), { kind: "CURRENT" });

  for (const input of [
    {
      projectNodeId: "PVT_old",
      bindingRevision: 3,
      source: { kind: "INELIGIBLE", reason: "not PRODUCT_APP" },
    },
    {
      projectNodeId: "PVT_old",
      bindingRevision: 3,
      source: { kind: "CURRENT", projectNodeId: "PVT_new", bindingRevision: 3 },
    },
    {
      projectNodeId: "PVT_current",
      bindingRevision: 2,
      source: { kind: "CURRENT", projectNodeId: "PVT_current", bindingRevision: 3 },
    },
  ] as const) {
    assert.equal(fleetProjectionBindingDisposition(input).kind, "SUPERSEDED");
  }
});

test("중앙 desired state와 provider readback gate를 서로 다른 terminal 상태로 보존한다", () => {
  assert.equal(fleetProjectionBindingDisposition({
    projectNodeId: "UNCONFIGURED:SEORILABS_FLEET",
    bindingRevision: null,
    source: { kind: "NEEDS_INPUT", reason: "central binding missing" },
  }).kind, "NEEDS_INPUT");
  assert.equal(fleetProjectionBindingDisposition({
    projectNodeId: "UNCONFIGURED:SEORILABS_FLEET",
    bindingRevision: null,
    source: { kind: "READBACK_REQUIRED", reason: "provider unavailable" },
  }).kind, "READBACK_REQUIRED");
});

test("stale APPLIED projection도 Project API write 전에 binding을 재검증한다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/control-plane/fleet-projector.ts"), "utf8");
  const claimApplied = source.indexOf('{ status: "APPLIED", updatedAt: { lte: staleAppliedBefore } }');
  const applyBindingCheck = source.indexOf("await reconcileProjectionBinding(bindingRow)");
  const projectWrite = source.indexOf("await ensureProjectItem(");
  const drainBindingCheck = source.indexOf("await reconcileProjectionBinding(row)");
  const drainApply = source.indexOf("await applyFleetProjectProjection(row.id)");

  assert.ok(claimApplied >= 0);
  assert.ok(applyBindingCheck > claimApplied);
  assert.ok(projectWrite > applyBindingCheck);
  assert.ok(drainBindingCheck >= 0);
  assert.ok(drainApply > drainBindingCheck);
  assert.match(source, /data: \{ status: disposition\.kind, lastError: disposition\.reason \}/);
  assert.match(source, /bindingRevision: projection\.bindingRevision/);
  assert.doesNotMatch(source, /projectV2Id/);
});

test("projection drain은 중복 catch-up 없이 전용 scheduler에 연결되고 미설정은 NEEDS_INPUT으로 닫힌다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/control-plane/fleet-projector.ts"), "utf8");
  // 미설정 row를 조회에서 제외하면 NEEDS_INPUT으로 닫을 기회 자체가 사라진다.
  assert.doesNotMatch(source, /projectNodeId: \{ not: \{ startsWith: "UNCONFIGURED:" \} \}/);
  assert.match(source, /if \(binding\.kind === "NEEDS_INPUT"\) \{/);
  assert.match(source, /return \{ scanned: rows\.length, applied, failed, needsInput, superseded \};/);

  const route = readFileSync(
    join(process.cwd(), "src/app/api/admin/automation/project-projections/route.ts"),
    "utf8",
  );
  assert.match(route, /reconcileFleetProjectProjections/);
  assert.match(route, /verifyStaticToken/);

  const reconcileBinding = source.indexOf("const binding = await reconcileFleetProjectBinding()");
  const reconcileSources = source.indexOf("const sources = await reconcileFleetProjectProjectionSources()");
  const drainProjection = source.indexOf("const projections = await drainFleetProjectProjections(limit)");
  assert.ok(reconcileBinding >= 0);
  assert.ok(reconcileSources > reconcileBinding);
  assert.ok(drainProjection > reconcileSources);

  const cronjobs = readFileSync(join(process.cwd(), "k8s/scheduler-cronjobs.yaml"), "utf8");
  const catchup = readFileSync(join(process.cwd(), "k8s/scheduler-catchup-job.yaml"), "utf8");
  const occurrences = (value: string) => value.split("/api/admin/automation/project-projections").length - 1;
  assert.equal(occurrences(cronjobs), 1);
  assert.equal(occurrences(catchup), 0);
  assert.match(cronjobs, /name: backoffice-fleet-project-projection/);
  assert.match(cronjobs, /name: backoffice-fleet-project-projection[\s\S]*?concurrencyPolicy: Forbid/);
});
