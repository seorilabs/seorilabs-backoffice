import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import { parseAllDocuments } from "yaml";

const execFileAsync = promisify(execFile);
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const IMAGE = `registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:${"a".repeat(64)}`;
const OCCURRENCE_ID = "fleet-occurrence-0001";
const RUN_ID = "fleet-run-0001";
const PROVIDER_VECTOR_DIGEST = `sha256:${"b".repeat(64)}`;
const JOB_NAME = `fleet-inventory-issuer-${createHash("sha256").update(OCCURRENCE_ID).digest("hex").slice(0, 40)}`;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  assert.ok(value && !Array.isArray(value) && typeof value === "object");
  return value as JsonRecord;
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function documents(source: string): JsonRecord[] {
  return parseAllDocuments(source).map((document) => record(document.toJSON()));
}

function byKind(items: JsonRecord[], kind: string): JsonRecord {
  const matches = items.filter((item) => item.kind === kind);
  assert.equal(matches.length, 1);
  return matches[0];
}

function named(items: unknown[], name: string): JsonRecord {
  const matches = items.map(record).filter((item) => item.name === name);
  assert.equal(matches.length, 1);
  return matches[0];
}

async function runEvidenceFilter(value: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn("jq", [
    "-ce",
    "--arg", "occurrence", OCCURRENCE_ID,
    "--arg", "run", RUN_ID,
    "--arg", "provider", PROVIDER_VECTOR_DIGEST,
    "-f", "scripts/fleet-migration-inventory-issuer-evidence.jq",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(JSON.stringify(value));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

test("issuer runner centrally renders one exact suspended Job and never mutates signer or credentials", async () => {
  const [runner, issuerManifest, signerManifest, evidenceFilter] = await Promise.all([
    readFile("scripts/run-fleet-migration-inventory-issuer.sh", "utf8"),
    readFile("k8s/fleet-migration-inventory-issuer-job.yaml", "utf8"),
    readFile("k8s/fleet-migration-inventory-signer.yaml", "utf8"),
    readFile("scripts/fleet-migration-inventory-issuer-evidence.jq", "utf8"),
  ]);
  const { stdout: renderedBase } = await execFileAsync("bash", [
    "scripts/render-manifest.sh",
    "k8s/fleet-migration-inventory-issuer-job.yaml",
    IMAGE,
    SOURCE_SHA,
  ]);
  const rendered = renderedBase
    .replaceAll("__FLEET_MIGRATION_OCCURRENCE_ID__", OCCURRENCE_ID)
    .replaceAll("__FLEET_MIGRATION_RUN_ID__", RUN_ID)
    .replaceAll("__FLEET_MIGRATION_PROVIDER_VECTOR_DIGEST__", PROVIDER_VECTOR_DIGEST)
    .replaceAll("__FLEET_MIGRATION_JOB_NAME__", JOB_NAME);
  assert.doesNotMatch(rendered, /__[A-Z0-9_]+__|:latest/u);

  const resources = documents(rendered);
  assert.deepEqual(resources.map((item) => item.kind).sort(), [
    "Job",
    "NetworkPolicy",
    "Role",
    "ServiceAccount",
  ]);
  const job = byKind(resources, "Job");
  const metadata = record(job.metadata);
  const annotations = record(metadata.annotations);
  const spec = record(job.spec);
  assert.equal(spec.suspend, true);
  assert.equal(spec.backoffLimit, 0);
  assert.equal(metadata.name, JOB_NAME);
  assert.equal(metadata.generateName, undefined);
  assert.equal(JOB_NAME.length, 63);
  assert.equal(annotations["seorilabs.dev/occurrence-id"], OCCURRENCE_ID);
  assert.equal(annotations["seorilabs.dev/run-id"], RUN_ID);
  assert.equal(annotations["seorilabs.dev/provider-vector-digest"], PROVIDER_VECTOR_DIGEST);
  assert.equal(annotations["seorilabs.dev/database-credential-id"], "shared/seori-auth/fleet-migration-inventory-issuer-db");
  assert.equal(annotations["seorilabs.dev/client-mtls-credential-id"], "shared/platform/fleet-migration-inventory-issuer-client-mtls");
  assert.equal(annotations["seorilabs.dev/github-app-credential-id"], "shared/github/backoffice-app");

  const templateSpec = record(record(record(spec.template).spec));
  const issuer = record(list(templateSpec.containers)[0]);
  assert.equal(issuer.image, IMAGE);
  assert.equal(templateSpec.automountServiceAccountToken, false);
  assert.equal(templateSpec.enableServiceLinks, false);
  assert.equal(templateSpec.shareProcessNamespace, false);
  assert.equal(record(issuer.securityContext).readOnlyRootFilesystem, true);
  assert.equal(record(issuer.securityContext).allowPrivilegeEscalation, false);
  assert.deepEqual(record(record(issuer.securityContext).capabilities).drop, ["ALL"]);
  const env = list(issuer.env).map(record);
  assert.equal(named(env, "FLEET_MIGRATION_OCCURRENCE_ID").value, OCCURRENCE_ID);
  assert.equal(named(env, "FLEET_MIGRATION_RUN_ID").value, RUN_ID);
  assert.equal(named(env, "FLEET_MIGRATION_PROVIDER_VECTOR_DIGEST").value, PROVIDER_VECTOR_DIGEST);
  assert.deepEqual(record(named(env, "DATABASE_URL").valueFrom).secretKeyRef, {
    name: "fleet-migration-inventory-issuer-db",
    key: "DATABASE_URL",
  });

  assert.match(runner, /issuer_documents=.*kubectl_bin.*create --dry-run=client/su);
  assert.match(runner, /select\(\.kind == "Job"\)/u);
  assert.match(runner, /printf '%s' "\$expected_job" \| "\$kubectl_bin" create -f - -o name/u);
  assert.match(runner, /openssl_bin.*dgst -sha256 -binary/su);
  assert.match(runner, /od_bin.*-An -v -tx1/su);
  assert.match(runner, /tr_bin.*-d ' \\n'/su);
  assert.match(runner, /job_name="fleet-inventory-issuer-\$\{occurrence_digest:0:40\}"/u);
  assert.match(runner, /READBACK_FIRST/u);
  assert.match(runner, /readback_template=/u);
  assert.doesNotMatch(runner, /get jobs -l/u);
  assert.doesNotMatch(runner, /printf '%s\\n' "\$rendered_issuer" \| "\$kubectl_bin" create -f - -o name/u);
  assert.ok(runner.indexOf("grep -q '__[A-Z0-9_]*__\\|:latest'") < runner.indexOf("job_ref="));
  assert.ok(runner.indexOf("actual_job=") < runner.indexOf('patch "job/$job_name"'));
  assert.match(runner, /\.spec\.suspend == true/u);
  assert.match(runner, /live signer Deployment image\/source\/readiness\/key-isolation binding/u);
  assert.match(runner, /status\.observedGeneration/u);
  assert.match(runner, /endpointslice/u);
  assert.match(runner, /read_bound_key_markers configmap fleet-migration-inventory-public-identity shared\/platform\/fleet-release-approval-signing/u);
  for (const binding of [
    "secret fleet-migration-inventory-issuer-db shared/seori-auth/fleet-migration-inventory-issuer-db",
    "secret fleet-migration-inventory-issuer-github-app shared/github/backoffice-app",
    "secret fleet-migration-inventory-signer-client shared/platform/fleet-migration-inventory-issuer-client-mtls",
    "secret fleet-migration-inventory-signer-server shared/platform/fleet-migration-inventory-signer-server-mtls",
    "secret fleet-release-approval-signing shared/platform/fleet-release-approval-signing",
  ]) {
    assert.ok(runner.includes(`read_bound_key_markers ${binding}`));
  }
  assert.match(runner, /read_key_markers secret registry-pull-cred/u);
  assert.match(runner, /seorilabs\.dev\/credential-id/u);
  assert.match(runner, /containerStatuses\[0\]\.imageID/u);
  assert.equal(runner.match(/containerStatuses\[0\]\.imageID/gu)?.length, 2);
  assert.match(runner, /issuer_pods=/u);
  assert.match(runner, /metadata\.uid == \$createdJobUid/u);
  assert.match(runner, /created_job_resource_version=/u);
  assert.match(runner, /"op":"test","path":"\/metadata\/uid"/u);
  assert.match(runner, /"op":"test","path":"\/metadata\/resourceVersion"/u);
  assert.match(runner, /"op":"test","path":"\/spec\/suspend","value":true/u);
  assert.match(runner, /patch "job\/\$job_name" --type=json/u);
  assert.doesNotMatch(runner, /patch "job\/\$job_name" --type=merge/u);
  assert.match(runner, /ownerReferences\[0\]\.uid == \$jobUid/u);
  assert.match(runner, /spec\.serviceAccountName == "fleet-migration-inventory-issuer"/u);
  assert.match(runner, /spec\.automountServiceAccountToken == false/u);
  assert.match(runner, /spec\.initContainers \/\/ \[\]/u);
  assert.match(runner, /spec\.ephemeralContainers \/\/ \[\]/u);
  assert.match(runner, /status\.phase == "Succeeded"/u);
  assert.match(runner, /state\.terminated\.exitCode == 0/u);
  assert.match(runner, /logs "pod\/\$issuer_pod_name" -c issuer/u);
  assert.doesNotMatch(runner, /logs "job\/\$job_name"/u);
  assert.match(runner, /fleet-migration-inventory-issuer-evidence\.jq/u);
  assert.match(runner, /printf '%s\\n' "\$sanitized_evidence"/u);
  assert.doesNotMatch(runner, /printf '%s\\n' "\$evidence"\s*$/mu);
  assert.match(evidenceFilter, /seorilabs-fleet-migration-authoritative-inventory-v1/u);
  assert.match(runner, /seorilabs\.dev\/signing-credential-id/u);
  assert.match(runner, /seorilabs\.dev\/server-mtls-credential-id/u);
  assert.doesNotMatch(runner, /get secret\/[^\n]+ -o (?:json|yaml)/u);
  assert.doesNotMatch(runner, /kubectl_bin[^\n]*(?:apply|delete|replace|rollout|scale)/u);
  assert.doesNotMatch(runner, /(?:create|patch) (?:secret|configmap|deployment|service|networkpolicy)/u);
  assert.match(runner, /동일 occurrence를 반복하지 않고 named Job을 별도 readback한다/u);
  assert.match(runner, /secret-free authoritative terminal readback/u);

  const rawJob = byKind(documents(issuerManifest), "Job");
  assert.equal(record(rawJob.metadata).name, "__FLEET_MIGRATION_JOB_NAME__");
  assert.equal(record(rawJob.metadata).generateName, undefined);
  assert.equal(record(record(rawJob.metadata).annotations)["seorilabs.dev/occurrence-id"], "__FLEET_MIGRATION_OCCURRENCE_ID__");
  const signer = byKind(documents(signerManifest), "Deployment");
  assert.equal(record(signer.spec).replicas, 0);
  assert.equal(record(record(signer.metadata).labels)["seorilabs.dev/source-sha"], "__BACKOFFICE_IMAGE_TAG__");
});

test("terminal evidence allows exactly public keys and never echoes rejected secret candidates", async () => {
  const valid = {
    schemaVersion: 1,
    contract: "seorilabs-fleet-migration-authoritative-inventory-v1",
    state: "PRESERVED",
    authoritativeState: "READY",
    inventoryDigest: `sha256:${"c".repeat(64)}`,
    issuanceDigest: `sha256:${"d".repeat(64)}`,
    keyFingerprint: `sha256:${"e".repeat(64)}`,
    occurrenceId: OCCURRENCE_ID,
    runId: RUN_ID,
    providerVectorDigest: PROVIDER_VECTOR_DIGEST,
    privateKeyInput: false,
    secretValuesReturned: false,
  };
  const accepted = await runEvidenceFilter(valid);
  assert.equal(accepted.code, 0);
  assert.equal(accepted.stderr, "");
  assert.deepEqual(JSON.parse(accepted.stdout), valid);
  assert.deepEqual(Object.keys(JSON.parse(accepted.stdout)).sort(), Object.keys(valid).sort());

  const canary = "DO_NOT_ECHO_SECRET_CANARY";
  for (const rejected of [
    { ...valid, secret: canary },
    { ...valid, token: canary },
    { ...valid, password: canary },
    { ...valid, inventoryDigest: canary },
  ]) {
    const result = await runEvidenceFilter(rejected);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, new RegExp(canary, "u"));
  }
});

test("production web mounts the public inventory identity non-optionally and fails rollout closed", async () => {
  const deploymentManifest = await readFile("k8s/deployment.yaml", "utf8");
  const deployment = byKind(documents(deploymentManifest), "Deployment");
  const spec = record(deployment.spec);
  const rollingUpdate = record(record(spec.strategy).rollingUpdate);
  assert.equal(rollingUpdate.maxUnavailable, 0);
  const podSpec = record(record(record(spec.template).spec));
  const web = named(list(podSpec.containers), "backoffice");
  const env = list(web.env).map(record);
  assert.equal(named(env, "FLEET_MIGRATION_INVENTORY_PUBLIC_ROOT").value, "/run/fleet-inventory/public");
  assert.equal(named(env, "FLEET_MIGRATION_INVENTORY_PUBLIC_KEY_FILE").value, "public-key.pem");
  assert.equal(named(env, "FLEET_MIGRATION_INVENTORY_PUBLIC_CATALOG_FILE").value, "catalog.json");
  const mount = named(list(web.volumeMounts), "fleet-migration-inventory-public-identity");
  assert.equal(mount.mountPath, "/run/fleet-inventory/public");
  assert.equal(mount.readOnly, true);
  const volume = named(list(podSpec.volumes), "fleet-migration-inventory-public-identity");
  const configMap = record(volume.configMap);
  assert.equal(configMap.name, "fleet-migration-inventory-public-identity");
  // yaml v2 parser는 leading-zero scalar를 decimal 440으로 보지만 Kubernetes
  // YAML decoder는 0440을 octal 288로 해석한다. raw manifest와 client render를
  // 각각 고정해 두 해석 경계를 섞지 않는다.
  assert.equal(configMap.defaultMode, 440);
  assert.match(deploymentManifest, /defaultMode: 0440/u);
  assert.equal(configMap.optional, undefined);
  assert.deepEqual(configMap.items, [
    { key: "public-key.pem", path: "public-key.pem" },
    { key: "catalog.json", path: "catalog.json" },
  ]);
});

test("issuer runner rejects malformed public identities before invoking cluster tools", async () => {
  await assert.rejects(
    execFileAsync("bash", ["scripts/run-fleet-migration-inventory-issuer.sh"], {
      env: {
        ...process.env,
        BACKOFFICE_IMAGE: IMAGE,
        BACKOFFICE_SOURCE_SHA: SOURCE_SHA,
        FLEET_MIGRATION_OCCURRENCE_ID: "bad",
        FLEET_MIGRATION_RUN_ID: RUN_ID,
        FLEET_MIGRATION_PROVIDER_VECTOR_DIGEST: PROVIDER_VECTOR_DIGEST,
        KUBECTL_BIN: "/usr/bin/false",
        CRANE_BIN: "/usr/bin/false",
        JQ_BIN: "/usr/bin/false",
      },
    }),
    (error: unknown) => {
      const result = record(error);
      assert.equal(result.code, 2);
      assert.match(String(result.stderr), /occurrence\/run identity/u);
      return true;
    },
  );
});
