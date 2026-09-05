import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_ATTESTATION_ROUTE,
} from "@/lib/control-plane/trusted-executor-bindings";
import {
  signAgentAdapterAttestation,
  verifyAgentAdapterAttestation,
} from "@/lib/control-plane/agent-adapter-attestation";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("candidate executor는 immutable worker와 별도 server gate로 배포된다", () => {
  const manifest = source("k8s/workflow-bundle-candidate-executor.yaml");
  const deployment = source("k8s/deployment.yaml");
  const packageJson = source("package.json");
  assert.match(manifest, /kind: CronJob[\s\S]*suspend: false/u);
  assert.match(manifest, /concurrencyPolicy: Forbid/u);
  assert.match(manifest, /image: __BACKOFFICE_IMAGE_DIGEST__/u);
  assert.match(manifest, /automountServiceAccountToken: false/u);
  assert.match(manifest, /workflow-bundle-candidate-executor\.cjs/u);
  assert.match(manifest, /GITHUB_PRIVATE_KEY_FILE/u);
  assert.match(manifest, /WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL/u);
  assert.match(manifest, /spiffe:\/\/seorilabs\.local\/ns\/auth-broker\/sa\/workflow-bundle-candidate-executor/u);
  assert.match(manifest, /workflow-bundle-candidate-backoffice/u);
  assert.match(manifest, /workflow-bundle-candidate-attestation/u);
  assert.match(manifest, /workflow-bundle-candidate-github/u);
  assert.match(manifest, /workflow-bundle-candidate-egress-tls/u);
  assert.match(manifest, /SEORI_EGRESS_PROXY_ORIGIN/u);
  assert.doesNotMatch(manifest, /cidr: 0\.0\.0\.0\/0|port: 443/u);
  assert.doesNotMatch(manifest, /seori-auth-agent-(?:backoffice|attestation|github)|AGENT_TRUSTED_ADAPTER_/u);
  assert.doesNotMatch(manifest, /ghp_|github_pat_|PERSONAL_ACCESS_TOKEN|GITHUB_TOKEN/u);
  assert.match(deployment, /name: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_DEPLOYED\s+value: "true"/u);
  assert.match(packageJson, /scripts\/workflow-bundle-candidate-executor\.ts/u);
});

test("candidate internal API는 bearer와 route-body attestation을 함께 소비한다", () => {
  const route = source("src/app/api/internal/workflow-bundle-candidate-executor/route.ts");
  const security = source("src/lib/control-plane/security.ts");
  assert.match(route, /authenticateTrustedExecutorRequest\(request, "workflow-bundle-candidate"\)/u);
  assert.match(route, /verifyAndConsumeAgentAdapterAttestation/u);
  assert.match(route, /deploymentGate: "workflow-bundle-candidate"/u);
  assert.match(
    source("src/lib/control-plane/trusted-executor-bindings.ts"),
    /deployed: "WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_DEPLOYED"/u,
  );
  assert.match(security, /trustedExecutorEnv\(binding\.env\.deployed\) !== "true"/u);
  assert.match(route, /heartbeatCandidateExecutor/u);
  assert.match(source("scripts/workflow-bundle-candidate-executor.ts"), /HEARTBEAT_INTERVAL_MS = 60_000/u);
  assert.doesNotMatch(route, /GITHUB_PRIVATE_KEY|createInstallationAccessToken/u);
});

test("candidate executor attestation은 exact route에서 실제 sign-verify되고 유사 경로는 거부된다", () => {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const requestId = "workflow-bundle-candidate:claim:session-1";
  const body = { operation: "CLAIM" };
  const token = signAgentAdapterAttestation({
    privateKey,
    runtimeIdentity: WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY,
    route: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_ATTESTATION_ROUTE,
    requestId,
    body,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 30_000,
    nonce: "candidate-attestation-1",
  });

  assert.equal(verifyAgentAdapterAttestation({
    token,
    publicKey,
    route: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_ATTESTATION_ROUTE,
    requestId,
    body,
    now,
  })?.runtimeIdentity, WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY);
  assert.equal(verifyAgentAdapterAttestation({
    token,
    publicKey,
    route: `${WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_ATTESTATION_ROUTE}/lookalike`,
    requestId,
    body,
    now,
  }), null);
  assert.throws(() => signAgentAdapterAttestation({
    privateKey,
    runtimeIdentity: WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY,
    route: `${WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_ATTESTATION_ROUTE}/lookalike`,
    requestId,
    body,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 30_000,
    nonce: "candidate-attestation-lookalike",
  }), /AGENT_ADAPTER_ATTESTATION_PAYLOAD_INVALID/u);
});

test("v5 승인 trust ConfigMap manifest는 공개 Ed25519 key registry만 담는다", () => {
  const manifest = source("k8s/workflow-bundle-v5-trust-configmap.yaml");
  assert.match(manifest, /name: backoffice-workflow-bundle-v5-trust/u);
  assert.match(manifest, /namespace: platform/u);
  assert.doesNotMatch(manifest, /PRIVATE KEY/u);
  const json = manifest.split("trusted-approval-keys.json: |")[1]!.split("\n").map((line) => line.slice(4)).join("\n");
  const registry = JSON.parse(json) as { schemaVersion: number; keys: Array<Record<string, string>> };
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.keys.length, 1);
  const key = registry.keys[0]!;
  assert.equal(key.algorithm, "Ed25519");
  assert.equal(key.keyId, "workflow-bundle-v5-20260902-145012ae1370");
  assert.equal(key.policyRevision, "workflow-bundle-v5-approval-v1");
  assert.equal(key.status, "ACTIVE");
  const publicKey = createPublicKey(key.publicKeyPem!);
  assert.equal(publicKey.asymmetricKeyType, "ed25519");
  assert.equal(publicKey.export({ type: "spki", format: "pem" }).toString().trim(), key.publicKeyPem!.trim());
  assert.equal(
    `sha256:${createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")}`,
    key.fingerprint,
  );
});

test("후보 executor adapter 실행 복제본은 backoffice-secrets에 암호문으로만 봉인된다", () => {
  const sealed = source("k8s/backoffice-sealedsecret.yaml");
  const deployment = source("k8s/deployment.yaml");
  for (const key of ["WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_TOKEN", "WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PUBLIC_KEY"]) {
    const match = sealed.match(new RegExp(`^    ${key}: (\\S+)$`, "mu"));
    assert.ok(match, `${key} sealed ciphertext missing`);
    // kubeseal 암호문은 base64이며 bearer(43자)나 PEM 원문보다 길다.
    assert.match(match![1]!, /^Ag[A-Za-z0-9+/=]{300,}$/u);
    assert.match(deployment, new RegExp(`key: ${key}\\s+optional: true`, "u"));
  }
  assert.doesNotMatch(sealed, /-----BEGIN|PRIVATE KEY|adapter\.bearer/u);
});

test("candidate GitHub transport는 installation token을 callback 밖으로 반환하지 않는다", () => {
  const transport = source("src/lib/github/ready-pr-installation-client.ts");
  const scoped = source("src/lib/github/scoped-installation-client.ts");
  assert.match(transport, /withFleetScopedGithubClient/u);
  // capability는 실행기가 정하고 transport는 그대로 넘긴다. 후보 실행기 쪽 고정은
  // 실행기 스크립트에서 확인한다.
  assert.match(
    source("scripts/workflow-bundle-candidate-executor.ts"),
    /capability: "github\.workflow-bundle-candidate\.ready-pr"/u,
  );
  assert.match(transport, /requestFetch/u);
  assert.match(scoped, /finally[\s\S]*revokeAccessToken/u);
  assert.doesNotMatch(transport, /process\.env\.(?:GITHUB_TOKEN|GH_TOKEN)|Authorization: token/u);
});
