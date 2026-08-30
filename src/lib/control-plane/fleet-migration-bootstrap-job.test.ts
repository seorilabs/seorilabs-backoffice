import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const IMAGE = `registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:${"a".repeat(64)}`;
const SOURCE_SHA = "b".repeat(40);
const DETECTOR_SHA = "c".repeat(40);

test("BOOTSTRAP shadow renders as a one-shot, source-bound Job outside the web pod", () => {
  const manifest = join(ROOT, "k8s/fleet-migration-bootstrap-shadow-job.yaml");
  const rendered = execFileSync(join(ROOT, "scripts/render-manifest.sh"), [manifest, IMAGE, SOURCE_SHA], { encoding: "utf8" })
    .replaceAll("__FLEET_MIGRATION_DETECTOR_SOURCE_SHA__", DETECTOR_SHA);
  assert.match(rendered, /^kind: Job$/mu);
  assert.match(rendered, /backoffLimit: 0/u);
  assert.match(rendered, /suspend: true/u);
  assert.match(rendered, /activeDeadlineSeconds: 3600/u);
  assert.match(rendered, /memory: 768Mi/u);
  assert.match(rendered, /memory: 2Gi/u);
  assert.match(rendered, /fieldPath: metadata\.labels\['batch\.kubernetes\.io\/controller-uid'\]/u);
  assert.match(rendered, /fieldPath: metadata\.uid/u);
  assert.match(rendered, new RegExp(IMAGE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(rendered, new RegExp(SOURCE_SHA, "u"));
  assert.match(rendered, new RegExp(DETECTOR_SHA, "u"));
  assert.doesNotMatch(rendered, /:latest|__BACKOFFICE_|__FLEET_MIGRATION_/u);
});

test("runner creates one Job, verifies immutable bindings, and never execs the web Deployment", () => {
  const runner = readFileSync(join(ROOT, "scripts/run-fleet-migration-bootstrap-shadow.sh"), "utf8");
  assert.match(runner, /kubectl_bin.*create -f - -o name/u);
  assert.match(runner, /job_image.*job_sha.*job_detector.*job_memory/su);
  assert.match(runner, /spec\.suspend.*true/su);
  assert.match(runner, /patch "job\/\$job_name" --type=merge -p '\{"spec":\{"suspend":false\}\}'/u);
  assert.match(runner, /terminal 상태 timeout/u);
  assert.match(runner, /동일 Job을 반복하지 않는다/u);
  assert.doesNotMatch(runner, /kubectl[^\n]*exec|deploy\/backoffice/u);
});
