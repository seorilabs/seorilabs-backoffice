import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const IMAGE = `registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:${"a".repeat(64)}`;
const SOURCE_SHA = "b".repeat(40);
const DETECTOR_SHA = "c".repeat(40);

function callObjectBody(source: string, call: string): string {
  const start = source.indexOf(`${call}({`);
  assert.notEqual(start, -1, `${call} 호출이 있어야 한다`);
  const bodyStart = start + `${call}({`.length;
  const end = source.indexOf("\n  });", bodyStart);
  assert.notEqual(end, -1, `${call} 입력 객체가 닫혀야 한다`);
  return source.slice(bodyStart, end);
}

function topLevelKeys(body: string): string[] {
  return [...body.matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*)(?::|,)/gmu)]
    .map((match) => match[1] as string);
}

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

test("AC-1: production shadow wires only read adapters plus occurrence audit writes", () => {
  const source = readFileSync(join(ROOT, "scripts/fleet-migration-bootstrap-shadow.ts"), "utf8");
  const collector = callObjectBody(source, "createFleetMigrationReadOnlyCollector");
  assert.deepEqual(topLevelKeys(collector), [
    "organizationId",
    "installationId",
    "detectorRepositoryId",
    "detectorSourceSha",
    "pageSize",
    "clock",
    "readGitHubAppCapability",
    "readInstallationRepositoriesPage",
    "readRepositoryHead",
    "readRepositoryTree",
    "readBlob",
    "validateLegacyDocument",
    "readBackofficePublicEvidence",
    "claimOccurrence",
    "completeOccurrence",
    "readOccurrence",
  ]);
  assert.doesNotMatch(collector, /\b(?:create|update|delete|dispatch|mutate)[A-Za-z0-9]*\b/u);
  assert.match(source, /githubMutations: 0,[\s\S]*domainMutations: 0,[\s\S]*occurrenceAuditWrites: 1,/u);
});

test("AC-2: readiness is discarded before collection and cannot become authoritative inventory", () => {
  const source = readFileSync(join(ROOT, "scripts/fleet-migration-bootstrap-shadow.ts"), "utf8");
  const readinessRead = source.indexOf("let readiness = await evaluateFleetMigrationShadowReadiness()");
  const readinessDiscard = source.indexOf("readiness = null as never;");
  const collectorCreate = source.indexOf("createFleetMigrationReadOnlyCollector({");
  assert.ok(readinessRead >= 0 && readinessRead < readinessDiscard && readinessDiscard < collectorCreate);

  const backoffice = callObjectBody(source, "createFleetMigrationBackofficeAdapter");
  assert.deepEqual(topLevelKeys(backoffice), [
    "detectorSourceSha",
    "readinessEvidenceDigest",
    "snapshotSigningKeyId",
    "snapshotPolicyRevision",
  ]);
  const collection = callObjectBody(source, "collector.collect");
  assert.deepEqual(topLevelKeys(collection), [
    "mode",
    "deliveryId",
    "requestedRunId",
    "inventoryId",
    "baselineRatification",
  ]);
  assert.doesNotMatch(collection, /readiness/u);
  assert.match(source, /authoritative: false,[\s\S]*readyForPlanning: false,/u);
});
