import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { fleetProjectionBindingDisposition } from "@/lib/control-plane/fleet-projector-binding";

test("Fleet projection은 ACTIVE app의 현재 Project binding과 정확히 같을 때만 write 가능하다", () => {
  assert.deepEqual(fleetProjectionBindingDisposition({
    projectNodeId: "PVT_current",
    app: { status: "ACTIVE", projectV2Id: "PVT_current" },
  }), { kind: "CURRENT" });

  for (const input of [
    { projectNodeId: "PVT_old", app: null },
    { projectNodeId: "PVT_old", app: { status: "PAUSED", projectV2Id: "PVT_old" } },
    { projectNodeId: "PVT_old", app: { status: "ACTIVE", projectV2Id: null } },
    { projectNodeId: "PVT_old", app: { status: "ACTIVE", projectV2Id: "PVT_new" } },
  ] as const) {
    assert.equal(fleetProjectionBindingDisposition(input).kind, "SUPERSEDED");
  }
});

test("미설정 projection은 binding이 계속 없을 때만 NEEDS_INPUT으로 남는다", () => {
  assert.equal(fleetProjectionBindingDisposition({
    projectNodeId: "UNCONFIGURED:app-1",
    app: { status: "ACTIVE", projectV2Id: null },
  }).kind, "NEEDS_INPUT");
  assert.equal(fleetProjectionBindingDisposition({
    projectNodeId: "UNCONFIGURED:app-1",
    app: { status: "ACTIVE", projectV2Id: "PVT_current" },
  }).kind, "SUPERSEDED");
});

test("stale APPLIED projection도 Project API write 전에 binding을 재검증한다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/control-plane/fleet-projector.ts"), "utf8");
  const claimApplied = source.indexOf('{ status: "APPLIED", updatedAt: { lte: staleAppliedBefore } }');
  const applyBindingCheck = source.indexOf("await reconcileProjectionBinding(projection)");
  const projectWrite = source.indexOf("await ensureProjectItem(");
  const drainBindingCheck = source.indexOf("await reconcileProjectionBinding(row)");
  const drainApply = source.indexOf("await applyFleetProjectProjection(row.id)");

  assert.ok(claimApplied >= 0);
  assert.ok(applyBindingCheck > claimApplied);
  assert.ok(projectWrite > applyBindingCheck);
  assert.ok(drainBindingCheck >= 0);
  assert.ok(drainApply > drainBindingCheck);
  assert.match(source, /data: \{ status: disposition\.kind, lastError: disposition\.reason \}/);
  assert.match(source, /app: \{ is: \{ status: "ACTIVE", projectV2Id: projection\.projectNodeId \} \}/);
});

test("projection drain은 정기 scheduler와 catch-up 양쪽에 한 번씩 연결되고 미설정은 NEEDS_INPUT으로 닫힌다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/control-plane/fleet-projector.ts"), "utf8");
  // 미설정 row를 조회에서 제외하면 NEEDS_INPUT으로 닫을 기회 자체가 사라진다.
  assert.doesNotMatch(source, /projectNodeId: \{ not: \{ startsWith: "UNCONFIGURED:" \} \}/);
  assert.match(source, /if \(binding\.kind === "NEEDS_INPUT"\) \{/);
  assert.match(source, /return \{ scanned: rows\.length, applied, failed, needsInput, superseded \};/);

  const route = readFileSync(
    join(process.cwd(), "src/app/api/admin/automation/project-projections/route.ts"),
    "utf8",
  );
  assert.match(route, /drainFleetProjectProjections/);
  assert.match(route, /verifyStaticToken/);

  const cronjobs = readFileSync(join(process.cwd(), "k8s/scheduler-cronjobs.yaml"), "utf8");
  const catchup = readFileSync(join(process.cwd(), "k8s/scheduler-catchup-job.yaml"), "utf8");
  const occurrences = (value: string) => value.split("/api/admin/automation/project-projections").length - 1;
  assert.equal(occurrences(cronjobs), 1);
  assert.equal(occurrences(catchup), 1);
  assert.match(cronjobs, /name: backoffice-fleet-project-projection/);
  assert.match(cronjobs, /name: backoffice-fleet-project-projection[\s\S]*?concurrencyPolicy: Forbid/);
});
