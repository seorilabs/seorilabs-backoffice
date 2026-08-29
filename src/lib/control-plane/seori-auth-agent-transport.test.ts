import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  assertPublicAgentResponse,
  parseExactHttpsOrigin,
  readBoundSecretFile,
  workerIdentityFromMtlsPeer,
} from "@/lib/control-plane/seori-auth-agent-transport";

test("helper는 exact HTTPS origin과 exact mTLS SPIFFE principal만 허용한다", () => {
  assert.equal(parseExactHttpsOrigin("https://backoffice.example").origin, "https://backoffice.example");
  assert.throws(() => parseExactHttpsOrigin("https://backoffice.example/api"));
  assert.throws(() => parseExactHttpsOrigin("https://user:pass@backoffice.example"));
  const identity = workerIdentityFromMtlsPeer({
    subjectAltName: "URI:spiffe://seorilabs.local/ns/agents/sa/codex/instance/123e4567-e89b-42d3-a456-426614174000",
    fingerprint256: Array.from({ length: 32 }, () => "AA").join(":"),
    serialNumber: "01AB",
    codexSpiffePrefix: "spiffe://seorilabs.local/ns/agents/sa/codex/instance",
    claudeSpiffePrefix: "spiffe://seorilabs.local/ns/agents/sa/claude/instance",
  });
  assert.equal(identity.principal, "codex:seorilabs-generic-worker");
  assert.match(identity.runtimeBindingDigest, /^[0-9a-f]{64}$/u);
  const otherInstance = workerIdentityFromMtlsPeer({
    subjectAltName: "URI:spiffe://seorilabs.local/ns/agents/sa/codex/instance/223e4567-e89b-42d3-a456-426614174000",
    fingerprint256: Array.from({ length: 32 }, () => "BB").join(":"),
    serialNumber: "02AB",
    codexSpiffePrefix: "spiffe://seorilabs.local/ns/agents/sa/codex/instance",
    claudeSpiffePrefix: "spiffe://seorilabs.local/ns/agents/sa/claude/instance",
  });
  assert.equal(otherInstance.principal, identity.principal);
  assert.notEqual(otherInstance.runtimeBindingDigest, identity.runtimeBindingDigest);
  assert.throws(() => workerIdentityFromMtlsPeer({
    subjectAltName: "URI:spiffe://seorilabs.local/ns/agents/sa/codex/instance/shared-service-account",
    fingerprint256: Array.from({ length: 32 }, () => "AA").join(":"),
    serialNumber: "01AB",
    codexSpiffePrefix: "spiffe://seorilabs.local/ns/agents/sa/codex",
    claudeSpiffePrefix: "spiffe://seorilabs.local/ns/agents/sa/claude",
  }));
});

test("helper 응답은 raw credential field와 credential 후보 값을 모델로 반환하지 않는다", () => {
  const sessionId = "agent-session:123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(assertPublicAgentResponse({ sessionId, status: "RUNNING" }), {
    sessionId,
    status: "RUNNING",
  });
  assert.throws(() => assertPublicAgentResponse({ leaseToken: "not-returned" }));
  assert.throws(() => assertPublicAgentResponse({ value: "Bearer abcdefghijklmnop" }));
});

test("projected-secret symlink는 fixed root 내부만 허용하고 world-readable 또는 escape는 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "seori-auth-secret-root-"));
  const outside = await mkdtemp(join(tmpdir(), "seori-auth-secret-outside-"));
  await mkdir(join(root, "..data"), { mode: 0o700 });
  await writeFile(join(root, "..data", "bearer"), "fixture-value\n", { mode: 0o640 });
  await symlink("..data/bearer", join(root, "bearer"));
  const value = await readBoundSecretFile({ root, relativePath: "bearer", allowGroupRead: true });
  try {
    assert.equal(value.toString("utf8"), "fixture-value\n");
  } finally {
    value.fill(0);
  }
  await chmod(join(root, "..data", "bearer"), 0o644);
  await assert.rejects(() => readBoundSecretFile({ root, relativePath: "bearer", allowGroupRead: true }));
  await writeFile(join(outside, "escape"), "fixture-value", { mode: 0o600 });
  await symlink(join(outside, "escape"), join(root, "escape"));
  await assert.rejects(() => readBoundSecretFile({ root, relativePath: "escape" }));
});

test("K8s runtime과 client는 기본 scale 0, no service-account token, RPI5, 분리 secret, mTLS-only로 선언된다", () => {
  const manifest = readFileSync(join(process.cwd(), "k8s/seori-auth-agent-runtime.yaml"), "utf8");
  assert.match(manifest, /name: seori-auth-agent-runtime[\s\S]*?replicas: 0/u);
  assert.match(manifest, /automountServiceAccountToken: false/u);
  assert.match(manifest, /kubernetes\.io\/hostname: rpi5/u);
  assert.match(manifest, /SEORI_AUTH_AGENT_TRANSPORT[\s\S]*?value: mtls/u);
  assert.match(manifest, /seori-auth-agent-backoffice/u);
  assert.match(manifest, /seori-auth-agent-attestation/u);
  assert.match(manifest, /seori-auth-agent-github/u);
  assert.match(manifest, /seori-auth-agent-server/u);
  assert.doesNotMatch(manifest, /kind: Secret/u);
  const deployment = readFileSync(join(process.cwd(), "k8s/deployment.yaml"), "utf8");
  assert.match(deployment, /AGENT_TRUSTED_ADAPTER_DEPLOYED[\s\S]*?value: "false"/u);
  const runtime = readFileSync(join(process.cwd(), "scripts/seori-auth-agent-runtime.ts"), "utf8");
  assert.match(runtime, /z\.literal\("mtls"\)/u);
  assert.match(runtime, /READY_PR_RUNTIME_OPERATIONAL = false/u);
  assert.doesNotMatch(runtime, /SEORI_AUTH_LOCAL_WORKER_PRINCIPAL|createHttpServer|SEORI_AUTH_AGENT_SOCKET/u);
  const client = readFileSync(join(process.cwd(), "scripts/seori-auth-agent-client.ts"), "utf8");
  assert.match(client, /z\.literal\("mtls"\)/u);
  assert.doesNotMatch(client, /from "node:http"|httpRequest|SEORI_AUTH_AGENT_SOCKET|assertPrivateUnixSocket|\["unix",\s*"mtls"\]/u);
});
