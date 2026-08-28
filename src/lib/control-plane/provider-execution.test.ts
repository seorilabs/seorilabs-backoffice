import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  providerCommandEnvelopeSchema,
  providerExecutionCreateSchema,
  providerExecutionSettlementSchema,
} from "@/lib/control-plane/contracts";
import {
  SeoriAuthBrokerProviderAdapter,
  buildAuthBrokerLeaseRequest,
  signRunAttestation,
} from "@/lib/control-plane/provider-adapter-client";
import {
  blueprintExecutionContract,
  compileProviderCommandEnvelope,
  decideBlueprintReadback,
  providerExecutionBindingHash,
  providerExecutionClaimRequiresApproval,
  providerExecutionCredentialForClaim,
  providerExecutionLeaseToken,
  providerExecutionRequiresApproval,
} from "@/lib/control-plane/provider-execution";

const sourceSha = "a".repeat(40);
const desiredHash = "b".repeat(64);
const bindingHash = "c".repeat(64);
const artifactChecksum = "d".repeat(64);

function envelope() {
  return compileProviderCommandEnvelope({
    executionId: "provider-execution-1",
    generation: 1,
    resumeMode: "START",
    operation: "UPLOAD_INTERNAL",
    provider: "google-play",
    repoId: 123n,
    repoFullName: "seorilabs/sample-app",
    sourceSha,
    configRevision: 2,
    desiredHash,
    desired: {
      market: "google-play",
      publicAccountId: "publisher-team",
      publicAppId: "com.seorilabs.sample",
      artifactChecksum,
    },
    resourceType: "market-release",
    resourceId: "com.seorilabs.sample",
    expectedPublicIdentity: "com.seorilabs.sample",
    artifactChecksum,
    bindingHash,
    credential: {
      logicalCredentialId: "shared/google-play/publisher",
      credentialGeneration: 3,
      policyGeneration: 7,
      capability: "google-play.upload.internal",
      publicAccountId: "publisher-team",
      credentialPublicIdentity: "seorilabs-play-publisher@seorilabs-gws.iam.gserviceaccount.com",
      adapterId: "google-play-api-v1",
      origin: "https://androidpublisher.googleapis.com",
      environment: "internal",
      authFactors: ["oidc"],
    },
    approval: {
      id: "provider-preapproval:execution-1:1",
      mode: "preapproved",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
}

test("provider execution create 계약은 blueprint/market allowlist 밖의 법적·심사·public action을 거부한다", () => {
  const blueprint = {
    kind: "BLUEPRINT_RESOURCE",
    repoId: "123",
    sourceSha,
    configRevision: 2,
    operation: "APPLY",
    resource: { provider: "gcp", resourceType: "project", resourceId: "sample-prod" },
  };
  assert.equal(providerExecutionCreateSchema.safeParse(blueprint).success, true);
  for (const bypass of [
    { ...blueprint, operation: "KEY_ROTATE" },
    { ...blueprint, operation: "PUBLIC_RELEASE" },
    { ...blueprint, legalApproval: true },
    { ...blueprint, password: "must-never-enter" },
  ]) {
    assert.equal(providerExecutionCreateSchema.safeParse(bypass).success, false);
  }
});

test("IAM과 domain-wide delegation만 protected mutation으로 분류하고 exact origin을 고정한다", () => {
  assert.equal(blueprintExecutionContract("gcp", "project")?.actionClass, "DETERMINISTIC_MUTATION");
  assert.deepEqual(blueprintExecutionContract("gcp", "iam-binding"), {
    provisioner: "gcp",
    capability: "gcp-project-provision",
    readbackCapability: "gcp-inventory-read",
    adapterId: "gcp-provisioner-v1",
    origin: "https://cloudresourcemanager.googleapis.com",
    actionClass: "PROTECTED_MUTATION",
  });
  assert.equal(blueprintExecutionContract("google-workspace", "domain-wide-delegation")?.actionClass, "PROTECTED_MUTATION");
  assert.equal(blueprintExecutionContract("firebase", "unknown"), null);
});

test("production mutation과 protected action은 실행별 승인을 요구하고 read-only/internal은 사전 승인할 수 있다", () => {
  assert.equal(providerExecutionRequiresApproval("READ_ONLY", "production"), false);
  assert.equal(providerExecutionRequiresApproval("DETERMINISTIC_MUTATION", "production"), true);
  assert.equal(providerExecutionRequiresApproval("PROTECTED_MUTATION", "internal"), true);
  assert.equal(providerExecutionRequiresApproval("INTERNAL_UPLOAD", "internal"), false);
  assert.equal(providerExecutionClaimRequiresApproval("DETERMINISTIC_MUTATION", "production", "READBACK_FIRST"), false);
});

test("result-unknown 재개는 mutation credential 대신 별도 fleet readback identity를 선택한다", () => {
  const primary = {
    logicalCredentialId: "shared/gcp/provisioner-session",
    credentialGeneration: 3,
    policyGeneration: 7,
    capability: "gcp-project-provision",
    publicAccountId: "organization-1",
    credentialPublicIdentity: "provisioner@example.iam.gserviceaccount.com",
    adapterId: "gcp-provisioner-v1",
    origin: "https://cloudresourcemanager.googleapis.com",
    environment: "production",
    authFactors: ["oidc"],
  };
  const readback = {
    ...primary,
    logicalCredentialId: "shared/gcp/fleet-inventory",
    credentialGeneration: 5,
    capability: "gcp-inventory-read",
    credentialPublicIdentity: "inventory@example.iam.gserviceaccount.com",
  };
  assert.equal(providerExecutionCredentialForClaim("START", primary, readback), primary);
  assert.equal(providerExecutionCredentialForClaim("READBACK_FIRST", primary, readback), readback);
});

test("binding hash는 repo/source/config/desired/public identity/credential generation 전체에 결합된다", () => {
  const base = {
    repoId: 123n,
    repoFullName: "seorilabs/sample-app",
    sourceSha,
    configRevisionId: "config-2",
    configRevision: 2,
    operation: "APPLY" as const,
    provider: "gcp",
    resourceType: "project",
    resourceId: "sample-prod",
    desiredHash,
    desired: { projectId: "sample-prod", region: "asia-northeast3" },
    expectedPublicIdentity: "projects/sample-prod",
    publicAccountId: "provisioner@example.iam.gserviceaccount.com",
    credentialPublicIdentity: "provisioner@example.iam.gserviceaccount.com",
    logicalCredentialId: "shared/gcp/provisioner-session",
    credentialGeneration: 3,
    policyGeneration: 7,
    capability: "gcp-project-provision",
    adapterId: "gcp-provisioner-v1",
    origin: "https://cloudresourcemanager.googleapis.com",
    environment: "production",
    authFactors: ["oidc"],
    readbackCredential: {
      logicalCredentialId: "shared/gcp/fleet-inventory",
      credentialGeneration: 5,
      policyGeneration: 7,
      capability: "gcp-inventory-read",
      publicAccountId: "inventory@example.iam.gserviceaccount.com",
      credentialPublicIdentity: "inventory@example.iam.gserviceaccount.com",
      adapterId: "gcp-provisioner-v1",
      origin: "https://cloudresourcemanager.googleapis.com",
      environment: "production",
      authFactors: ["oidc"],
    },
  };
  const digest = providerExecutionBindingHash(base);
  for (const changed of [
    { ...base, repoId: 124n },
    { ...base, sourceSha: "e".repeat(40) },
    { ...base, configRevision: 3 },
    { ...base, desiredHash: "f".repeat(64) },
    { ...base, desired: { projectId: "other-prod", region: "asia-northeast3" } },
    { ...base, publicAccountId: "other@example.iam.gserviceaccount.com" },
    { ...base, credentialGeneration: 4 },
    { ...base, readbackCredential: { ...base.readbackCredential, credentialGeneration: 6 } },
    { ...base, authFactors: ["api_key"] },
  ]) {
    assert.notEqual(providerExecutionBindingHash(changed), digest);
  }
});

test("readback-first envelope은 원래 mutation 대신 READBACK만 내보내고 arbitrary shell 필드를 거부한다", () => {
  const command = { ...envelope(), resumeMode: "READBACK_FIRST" as const, operation: "READBACK" as const };
  assert.equal(providerCommandEnvelopeSchema.parse(command).operation, "READBACK");
  assert.equal(providerCommandEnvelopeSchema.safeParse({ ...command, executable: "/bin/sh" }).success, false);
  assert.equal(providerCommandEnvelopeSchema.safeParse({ ...command, argv: ["-c", "printenv"] }).success, false);
  assert.equal(providerCommandEnvelopeSchema.safeParse({ ...command, env: { TOKEN: "never" } }).success, false);
});

test("provider visibility FORBIDDEN은 ABSENT와 분리되고 public identity drift도 감지한다", () => {
  const expected = { desiredHash, publicIdentity: "projects/sample-prod" };
  assert.equal(decideBlueprintReadback({ schemaVersion: 1, visibility: "FORBIDDEN", state: "UNKNOWN", attributes: {} }, expected), "FORBIDDEN");
  assert.equal(decideBlueprintReadback({ schemaVersion: 1, visibility: "VISIBLE", state: "ABSENT", attributes: {} }, expected), "ABSENT");
  assert.equal(decideBlueprintReadback({
    schemaVersion: 1,
    visibility: "VISIBLE",
    state: "PRESENT",
    publicIdentity: "projects/other",
    attributes: { desiredHash },
  }, expected), "DRIFT");
});

test("queue lease token은 worker와 generation이 다르면 재사용할 수 없다", () => {
  const signingKey = "queue-signing-key-which-is-long-enough";
  const first = providerExecutionLeaseToken({ signingKey, executionId: "execution-1", generation: 1, workerId: "worker-a" });
  assert.notEqual(first, providerExecutionLeaseToken({ signingKey, executionId: "execution-1", generation: 2, workerId: "worker-a" }));
  assert.notEqual(first, providerExecutionLeaseToken({ signingKey, executionId: "execution-1", generation: 1, workerId: "worker-b" }));
  assert.notEqual(first, providerExecutionLeaseToken({ signingKey, executionId: "execution-2", generation: 1, workerId: "worker-a" }));
});

test("Auth Broker lease에는 logical credential과 전체 binding digest만 전달하고 desired/secret/export를 넣지 않는다", () => {
  const request = buildAuthBrokerLeaseRequest(envelope(), "k8s:platform:provider-execution-worker");
  assert.equal(request.resource.id, `binding:${bindingHash}`);
  assert.equal(request.credentialRef, "shared/google-play/publisher");
  const encoded = JSON.stringify(request);
  assert.doesNotMatch(encoded, /password|totpSeed|privateKey|secretExport|artifactChecksum/);
  assert.equal("desired" in request, false);
});

test("mTLS scheduler attestation은 exact SPIFFE/run/repo/worker payload에 Ed25519 서명한다", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const token = signRunAttestation({
    privateKey,
    clientSpiffeId: "spiffe://seorilabs.local/ns/platform/sa/provider-execution-worker",
    subject: "k8s:platform:provider-execution-worker",
    runId: "provider-execution-1",
    repository: "seorilabs/sample-app",
    workerId: "provider-worker-1",
    now: 1_700_000_000_000,
    nonce: "provider-attest-0001",
  });
  const [payload, signature] = token.split(".");
  assert.equal(verify(null, Buffer.from(`seori-run-attestation-v1\n${payload}`, "utf8"), publicKey, Buffer.from(signature, "base64url")), true);
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.equal(decoded.repository, "seorilabs/sample-app");
  assert.equal(decoded.runId, "provider-execution-1");
});

test("Auth Broker execute transport가 불명확하면 adapter를 재실행하지 않고 RESULT_UNKNOWN을 반환한다", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  let calls = 0;
  const adapter = new SeoriAuthBrokerProviderAdapter({
    workerId: "provider-worker-1",
    subject: "k8s:platform:provider-execution-worker",
    clientSpiffeId: "spiffe://seorilabs.local/ns/platform/sa/provider-execution-worker",
    attestationPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    transport: async () => {
      calls += 1;
      if (calls === 1) return { status: 201, body: { credentialCheckout: { id: "checkout-1", generation: 1 } } };
      throw new Error("response lost");
    },
  });
  assert.deepEqual(await adapter.execute(envelope()), {
    outcome: "RESULT_UNKNOWN",
    errorCode: "AUTH_BROKER_EXECUTION_UNKNOWN",
  });
  assert.equal(calls, 2);
});

test("settlement 계약은 observation과 공개 error code 조합을 fail-closed한다", () => {
  const base = { executionId: "execution-1", generation: 1, leaseToken: "x".repeat(32) };
  assert.equal(providerExecutionSettlementSchema.safeParse({ ...base, outcome: "OBSERVED" }).success, false);
  assert.equal(providerExecutionSettlementSchema.safeParse({ ...base, outcome: "FAILED" }).success, false);
  assert.equal(providerExecutionSettlementSchema.safeParse({ ...base, outcome: "FAILED", errorCode: "ADAPTER_FAILED" }).success, true);
  assert.equal(providerExecutionSettlementSchema.safeParse({ ...base, outcome: "FAILED", errorCode: "raw provider error text" }).success, false);
});

test("migration과 worker manifest는 secret/export 컬럼·worker secret RBAC·자동 활성화를 만들지 않는다", () => {
  const migration = readFileSync(join(process.cwd(), "prisma/migrations/20260828230000_provider_execution_queue/migration.sql"), "utf8");
  const manifest = readFileSync(join(process.cwd(), "k8s/provider-execution-worker.yaml"), "utf8");
  assert.match(migration, /CREATE TABLE `control_plane_provider_execution`/);
  assert.match(migration, /`leaseTokenHash` CHAR\(64\)/);
  assert.doesNotMatch(migration, /`(?:password|totp|cookie|privateKey|apiKey|secretValue)`/i);
  assert.match(manifest, /rules: \[\]/);
  assert.match(manifest, /replicas: 0/);
  assert.doesNotMatch(manifest, /\b(?:get|list|watch)\b[^\n]*\bsecrets\b/i);
});
