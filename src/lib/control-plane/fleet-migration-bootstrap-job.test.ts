import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const IMAGE = `registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:${"a".repeat(64)}`;
const SOURCE_SHA = "b".repeat(40);
const DETECTOR_SHA = "c".repeat(40);
const EXECUTION_ID = "fleet-execution-0001";
const RUNTIME_KEY_FINGERPRINT = "d".repeat(64);
const PROOF_APPROVAL_KEY_FINGERPRINT = "e".repeat(64);
const RUNTIME_CONFIG_MAP = "fleet-runtime-public-0001";
const TOKEN_SECRET = "fleet-runtime-token-0001";

function callObjectBody(source: string, call: string): string {
  const start = source.indexOf(`${call}({`);
  assert.notEqual(start, -1, `${call} 호출이 있어야 한다`);
  const bodyStart = start + `${call}({`.length;
  const end = source.indexOf("\n    });", bodyStart);
  assert.notEqual(end, -1, `${call} 입력 객체가 닫혀야 한다`);
  return source.slice(bodyStart, end);
}

function topLevelKeys(body: string): string[] {
  const matches = [...body.matchAll(/^( +)([A-Za-z][A-Za-z0-9]*)(?::|,)/gmu)];
  const minimum = Math.min(...matches.map((match) => match[1]!.length));
  return matches
    .filter((match) => match[1]!.length === minimum)
    .map((match) => match[2] as string);
}

test("BOOTSTRAP shadow renders as a one-shot, source-bound Job outside the web pod", () => {
  const manifest = join(ROOT, "k8s/fleet-migration-bootstrap-shadow-job.yaml");
  const rendered = execFileSync(join(ROOT, "scripts/render-manifest.sh"), [manifest, IMAGE, SOURCE_SHA], { encoding: "utf8" })
    .replaceAll("__FLEET_MIGRATION_DETECTOR_SOURCE_SHA__", DETECTOR_SHA)
    .replaceAll("__FLEET_MIGRATION_EXECUTION_ID__", EXECUTION_ID)
    .replaceAll("__FLEET_MIGRATION_RUNTIME_KEY_FINGERPRINT__", RUNTIME_KEY_FINGERPRINT)
    .replaceAll("__FLEET_MIGRATION_RUNTIME_CONFIG_MAP__", RUNTIME_CONFIG_MAP)
    .replaceAll("__FLEET_MIGRATION_GITHUB_TOKEN_SECRET__", TOKEN_SECRET);
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
  assert.match(rendered, new RegExp(RUNTIME_KEY_FINGERPRINT, "u"));
  assert.doesNotMatch(rendered, /:latest|__BACKOFFICE_|__FLEET_MIGRATION_/u);
  assert.doesNotMatch(rendered, /GITHUB_PRIVATE_KEY|GITHUB_APP_ID|CONTROL_PLANE_SNAPSHOT_SIGNING_KEY/u);
  assert.doesNotMatch(rendered, /mysql-root-cred|mysql-root-password|fleet-migration-proof-writer-db/u);
  assert.match(rendered, /name: fleet-migration-shadow-db/u);
  assert.match(rendered, /defaultMode: 0440/u);
});

test("runner creates one Job, verifies immutable bindings, and never execs the web Deployment", () => {
  const runner = readFileSync(join(ROOT, "scripts/run-fleet-migration-bootstrap-shadow.sh"), "utf8");
  assert.match(runner, /kubectl_bin.*create -f - -o name/u);
  assert.match(runner, /crane_bin config.*org\.opencontainers\.image\.revision/su);
  assert.match(runner, /expected_policy.*actual_policy/su);
  assert.match(runner, /job_json.*resources\.limits\.memory/su);
  assert.match(runner, /runtime_config_map.*github_token_secret/su);
  assert.match(runner, /runtime_key_fingerprint.*등록된 Ed25519 SPKI SHA-256/su);
  assert.match(runner, /FLEET_MIGRATION_RUNTIME_ATTESTATION_KEY_FINGERPRINT/su);
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
  assert.match(source, /githubMutations: 0,[\s\S]*domainMutations: 0,[\s\S]*occurrenceAuditWrites: 2,/u);
  assert.doesNotMatch(source, /from "@\/lib\/github\/app"|GITHUB_PRIVATE_KEY|CONTROL_PLANE_SNAPSHOT_SIGNING_KEY/u);
  assert.match(source, /loadFleetMigrationRuntimeCapability/u);
  assert.match(source, /createFleetMigrationFinalizer/u);
});

test("AC-2: readiness is discarded before collection and cannot become authoritative inventory", () => {
  const source = readFileSync(join(ROOT, "scripts/fleet-migration-bootstrap-shadow.ts"), "utf8");
  const readinessRead = source.indexOf("let readiness = await evaluateFleetMigrationShadowReadiness({");
  const readinessDiscard = source.indexOf("readiness = null as never;");
  const collectorCreate = source.indexOf("createFleetMigrationReadOnlyCollector({");
  assert.ok(readinessRead >= 0 && readinessRead < readinessDiscard && readinessDiscard < collectorCreate);

  const backoffice = callObjectBody(source, "createFleetMigrationBackofficeAdapter");
  assert.deepEqual(topLevelKeys(backoffice), [
    "detectorSourceSha",
    "readinessEvidenceDigest",
    "readinessCohortDigest",
    "snapshotSigningKeyId",
    "snapshotPolicyRevision",
    "approvedProofDigests",
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

test("proof writer is a suspended INSERT-only principal Job with DB-only egress", () => {
  const manifest = join(ROOT, "k8s/fleet-migration-proof-writer-job.yaml");
  const rendered = execFileSync(join(ROOT, "scripts/render-manifest.sh"), [manifest, IMAGE, SOURCE_SHA], { encoding: "utf8" })
    .replaceAll("__FLEET_MIGRATION_PROOF_REQUEST_CONFIG_MAP__", "fleet-proof-request-0001")
    .replaceAll("__FLEET_MIGRATION_PROOF_APPROVAL_KEY_FINGERPRINT__", PROOF_APPROVAL_KEY_FINGERPRINT);
  assert.match(rendered, /^kind: Job$/mu);
  assert.match(rendered, /suspend: true/u);
  assert.match(rendered, /fleet-migration-proof-writer-db/u);
  assert.match(rendered, /fleet-migration-proof-writer\.cjs/u);
  assert.match(rendered, /defaultMode: 0440/u);
  assert.match(rendered, /readOnlyRootFilesystem: true/u);
  assert.match(rendered, /seccompProfile: \{ type: RuntimeDefault \}/u);
  assert.match(rendered, new RegExp(PROOF_APPROVAL_KEY_FINGERPRINT, "u"));
  assert.doesNotMatch(rendered, /GITHUB_PRIVATE_KEY|GITHUB_APP_ID|CONTROL_PLANE_SNAPSHOT_SIGNING_KEY|:latest|__[A-Z0-9_]*__/u);

  const networkPolicy = readFileSync(join(ROOT, "k8s/fleet-migration-proof-writer-network-policy.yaml"), "utf8");
  assert.match(networkPolicy, /namespace: platform/u);
  assert.match(networkPolicy, /kubernetes\.io\/metadata\.name: data/u);
  assert.match(networkPolicy, /port: 3306/u);
  assert.doesNotMatch(networkPolicy, /port: (?:53|80|443)\b/u);
});

test("DB principal and trigger provisioning stays outside Prisma migration and rejects broad grants", () => {
  const migration = readFileSync(join(
    ROOT,
    "prisma/migrations/20260830060000_fleet_migration_bootstrap_shadow/migration.sql",
  ), "utf8");
  assert.doesNotMatch(migration, /CREATE USER|GRANT |CREATE TRIGGER/u);

  const provisioning = readFileSync(join(ROOT, "k8s/fleet-migration-security-provisioning-job.yaml"), "utf8");
  assert.match(provisioning, /fleet_migration_shadow/u);
  assert.match(provisioning, /fleet_migration_proof_writer/u);
  assert.match(provisioning, /GRANT INSERT ON backoffice\.control_plane_fleet_migration_collection_occurrence/u);
  assert.match(provisioning, /GRANT INSERT ON backoffice\.control_plane_fleet_migration_collection_completion/u);
  assert.match(provisioning, /GRANT INSERT ON backoffice\.control_plane_fleet_migration_proof_snapshot/u);
  assert.doesNotMatch(provisioning, /GRANT (?:UPDATE|DELETE|ALL|CREATE|DROP|ALTER)\b/u);
  assert.match(provisioning, /information_schema\.APPLICABLE_ROLES/u);
  assert.match(provisioning, /information_schema\.TABLE_PRIVILEGES/u);
  assert.match(provisioning, /shadow_bytes="\$\(wc -c < \/run\/secrets\/shadow\/password/u);
  assert.match(provisioning, /test "\$shadow_bytes" = "\$\{#shadow_password\}"/u);
  assert.match(provisioning, /writer_bytes="\$\(wc -c < \/run\/secrets\/writer\/password/u);
  assert.match(provisioning, /test "\$writer_bytes" = "\$\{#writer_password\}"/u);
  assert.doesNotMatch(provisioning, /od -An -v -tx1 \/run\/secrets\/(?:shadow|writer)\/password/u);
  assert.match(provisioning, /ttlSecondsAfterFinished: 600/u);
  assert.match(provisioning, /trap 'rm -f "\$root_cnf" "\$shadow_cnf" "\$writer_cnf" "\$create_sql" "\$trigger_sql"'/u);

  const shadow = readFileSync(join(ROOT, "k8s/fleet-migration-bootstrap-shadow-job.yaml"), "utf8");
  const proofWriter = readFileSync(join(ROOT, "k8s/fleet-migration-proof-writer-job.yaml"), "utf8");
  assert.doesNotMatch(`${shadow}\n${proofWriter}`, /mysql-root-cred|mysql-root-password|CREATE USER|GRANT /u);
});

test("finalizer는 GitHub와 BO 최종 vector 뒤 capability TTL을 다시 확인하고 INSERT한다", () => {
  const source = readFileSync(join(ROOT, "src/lib/control-plane/fleet-migration-finalizer.ts"), "utf8");
  const githubRead = source.indexOf("await readFinalGithubVector");
  const transaction = source.indexOf("client.$transaction", githubRead);
  const backofficeRead = source.indexOf("await backoffice.readBackofficePublicEvidence", transaction);
  const finalFreshness = source.indexOf("input.assertRuntimeFresh();", backofficeRead);
  const completion = source.indexOf("occurrence.complete", finalFreshness);
  assert.match(source, /const seenCursors = new Set<string>\(\);[\s\S]*if \(!terminalPage\) fail\("FLEET_MIGRATION_FINAL_GITHUB_PAGINATION_INCOMPLETE"\)/u);
  assert.ok(
    githubRead >= 0
    && githubRead < transaction
    && transaction < backofficeRead
    && backofficeRead < finalFreshness
    && finalFreshness < completion,
  );
});
