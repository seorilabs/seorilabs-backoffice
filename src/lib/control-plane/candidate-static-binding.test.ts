import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";

import { readCandidateStaticBinding } from "@/lib/control-plane/candidate-static-binding";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { contractCanonicalJson, jsonDigest, signSnapshot, type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";

const REPO_ID = "1335099739";
const FULL_NAME = "seorilabs/saju-reader";
const SOURCE = "a".repeat(40);
const BUNDLE = "b".repeat(40);
const SIGNING_KEY = "candidate-static-binding-test-signing-key";
const digest = (value: unknown) => `sha256:${createHash("sha256").update(contractCanonicalJson(value as JsonValue)).digest("hex")}`;
const options = {
  signingKey: SIGNING_KEY,
  snapshotSignatureKeyId: "control-plane-snapshot-v1",
  snapshotSignaturePolicyRevision: "snapshot-policy-v1",
  now: new Date("2026-09-10T00:00:00Z"),
};

function fixture(repositoryId = REPO_ID, fullName = FULL_NAME, profile = "capacitor") {
  const candidatePayload = {
    schemaVersion: 2, bundleVersion: "5.0.0",
    source: { repository: "seorilabs/.github", sha: BUNDLE, workflowExecutionSha: BUNDLE },
    quality: {
      contractDigests: { "contracts/workflow-bundle-v5.schema.json": `sha256:${"1".repeat(64)}` },
      runtimeAssetDigests: { "scripts/fleet/static-runtime-binding-v5.mjs": `sha256:${"2".repeat(64)}` },
    },
    promotionScope: { staticProfiles: ["react-native", "godot", "capacitor"], buildProfiles: ["react-native-android", "godot-android"] },
    staticRuntimeBinding: {}, buildRuntimeBinding: {},
    staticProfiles: Object.fromEntries(["react-native", "godot", "capacitor", "ait-web"].map((profile) => [profile, {
      path: profile === "godot" ? ".github/workflows/godot-checks-v3.yml" : ".github/workflows/js-static-checks-v1.yml",
      runtime: profile, sha: BUNDLE,
    }])),
    buildProfiles: Object.fromEntries(["react-native", "godot"].map((profile) => [`${profile}-android`, {
      target: "android", executor: "cloud-build-x64",
      workflow: `.github/workflows/${profile === "react-native" ? "rn" : "godot"}-build-android-cloud-v2.yml`,
      artifactKind: "android-aab", scriptPath: "scripts/build-android.sh",
      builderImage: `builder/test@sha256:${"3".repeat(64)}`, sha: BUNDLE,
    }])),
    actions: {}, runners: {}, toolchains: {}, callerPolicies: {}, lifecyclePolicy: {},
    approval: { state: "CANDIDATE", evidence: [] },
  };
  const bundleDigest = digest(candidatePayload);
  const record = {
    id: "candidate-static-test", registryId: "seorilabs-workflow-bundles-v5", subject: `workflow-bundle-v5:${BUNDLE}`,
    approvalState: "CANDIDATE", sourceSha: BUNDLE, workflowExecutionSha: BUNDLE, bundleVersion: "5.0.0",
    payloadDigest: bundleDigest, candidateDigest: null, evidenceDigest: null, approvalPayloadDigest: null,
    approvalKeyId: null, approvalPolicyRevision: null, approvalSlot: null, activeApprovalSlot: null,
    supersededAt: null, supersededByRecordId: null, createdAt: options.now,
    contractDigestsDigest: digest(candidatePayload.quality.contractDigests),
    runtimeAssetDigestsDigest: digest(candidatePayload.quality.runtimeAssetDigests),
    artifactRepository: "seorilabs/.github", artifactRepositoryId: 1241442018n,
    artifactWorkflowPath: ".github/workflows/workflow-bundle-v5-candidate.yml",
    artifactRunId: 100n, artifactRunAttempt: 1, artifactId: 200n,
    artifactName: `workflow-bundle-v5-candidate-${BUNDLE}`, artifactDigest: `sha256:${"4".repeat(64)}`,
    requestHash: jsonDigest({ mode: "CANDIDATE", sourceSha: BUNDLE, runId: "100", runAttempt: 1, artifactId: "200" }),
    bundle: { ...candidatePayload, integrity: { algorithm: "sha256", payloadDigest: bundleDigest } },
  };
  const app = { id: "app-static-test", repoId: BigInt(repositoryId), repoFullName: fullName, status: "ACTIVE" };
  const registration = {
    repoId: BigInt(repositoryId), repoFullName: fullName, classification: "PRODUCT_APP", managementKind: "APP",
    archived: false, status: "MANAGED", defaultBranch: "main", lastDefaultPushSha: SOURCE, lastReconciledSha: SOURCE,
  };
  const payload = {
    schemaVersion: 1, markets: [],
    build: {
      workflowBundleSha: BUNDLE, workflowBundleDigest: bundleDigest,
      dependencyAuditException: {
        schemaVersion: 1, repositoryId, fullName,
        bindings: ["STATIC_CHECK", "ANDROID_BUILD_ONLY"].map((actionClass) => ({ actionClass, sourceSha: SOURCE, lockfileSha256: `sha256:${"5".repeat(64)}` })),
        expiresAt: "2026-10-03T00:00:00Z", reason: "공식 상위 패치 대기 중인 감사 예외",
        advisories: [{ ghsa: "GHSA-2p57-rm9w-gvfp", module: "ip", severity: "high", versions: ["1.1.9"] }],
      },
    },
  };
  if (profile === "godot") delete (payload.build as { dependencyAuditException?: unknown }).dependencyAuditException;
  const revision = {
    id: "config-static-test", appId: app.id, revision: 51, status: "ACTIVE", payload,
    payloadHash: "", activatedSnapshot: {} as Record<string, unknown>, snapshotDigest: "", snapshotSignature: "",
  };
  const resign = () => {
    revision.payloadHash = jsonDigest(payload as JsonValue);
    revision.activatedSnapshot = { schemaVersion: 1, appId: app.id, repoId: repositoryId, repoFullName: fullName,
      revision: 51, payloadHash: revision.payloadHash, payload: structuredClone(payload), activatedAt: options.now.toISOString() };
    const signed = signSnapshot(revision.activatedSnapshot as JsonValue, SIGNING_KEY);
    revision.snapshotDigest = signed.digest;
    revision.snapshotSignature = signed.signature;
  };
  resign();
  const discovery = { id: "discovery-static-test", sourceSha: SOURCE, sourceRef: "refs/heads/main",
    requestHash: "6".repeat(64), workflowProfile: profile, workflowPackageManager: profile === "godot" ? null : "pnpm",
    workflowWorkingDirectory: profile === "godot" ? "." : "app", payload: {}, buildBindings: [] };
  const stored: { app: typeof app | null; registration: typeof registration | null; record: typeof record | null;
    revision: typeof revision | null; discovery: typeof discovery | null } = { app, registration, record, revision, discovery };
  const client = {
    app: { findUnique: async () => stored.app },
    repositoryRegistration: { findUnique: async () => stored.registration },
    workflowBundleRegistryRecord: { findUnique: async () => stored.record },
    configRevision: { findFirst: async () => stored.revision },
    discoveryObservation: { findFirst: async () => stored.discovery },
  };
  const query = { repositoryId: repositoryId as "1335099739" | "1250442131" | "1265192029", sourceSha: SOURCE,
    workflowBundleRecordId: record.id, workflowBundleSha: BUNDLE, workflowBundleDigest: bundleDigest };
  return { query, client, stored, app, registration, record, revision, discovery, payload, resign };
}

const read = (value: ReturnType<typeof fixture>, override = {}) => readCandidateStaticBinding(value.query, { ...options, ...override }, value.client as never);

test("실제 registry integrity와 서명된 ACTIVE snapshot에서 중앙 loader envelope를 반환하고 원본을 보존한다", async () => {
  const value = fixture();
  const before = structuredClone(value.stored);
  const result = await read(value);
  assert.equal(result.scope, "STATIC_CHECK");
  assert.equal(result.mutationAttempted, false);
  assert.equal(result.callerPath, ".github/workflows/org-contract.yml");
  assert.equal(result.candidate.id, value.record.id);
  assert.equal(result.binding.state, "VERIFIED");
  assert.equal(result.binding.sourceSha, SOURCE);
  assert.equal(result.binding.manifest.staticBinding.profile, "capacitor");
  assert.equal(result.binding.manifestDigest, digest(result.binding.manifest));
  assert.equal(result.binding.configRevisionDigest, `sha256:${value.revision.payloadHash}`);
  assert.equal(result.binding.signedSnapshotDigest, `sha256:${value.revision.snapshotDigest}`);
  assert.notEqual(result.binding.snapshotSignatureDigest, `sha256:${value.revision.snapshotSignature}`);
  assert.ok(!JSON.stringify(result).includes(value.revision.snapshotSignature));
  assert.deepEqual(value.stored, before);
});

test("세 앱의 exact id/name/static profile만 허용하며 Android 실행 응답을 만들지 않는다", async () => {
  for (const [id, name, profile] of [[REPO_ID, FULL_NAME, "capacitor"], ["1250442131", "seorilabs/happy-farm", "react-native"], ["1265192029", "seorilabs/lizard-tycoon", "godot"]]) {
    const value = fixture(id, name, profile);
    const result = await read(value);
    assert.equal(result.binding.repositoryId, id);
    assert.equal(result.binding.fullName, name);
    assert.equal(result.binding.manifest.staticBinding.profile, profile);
    assert.equal(result.scope, "STATIC_CHECK");
    assert.equal("runId" in result, false);
  }
});

test("다른 repo, APPROVED, SHA/digest 및 registry artifact 변조를 거부한다", async () => {
  const cases: Array<[string, (value: ReturnType<typeof fixture>) => void]> = [
    ["CANDIDATE_STATIC_REPOSITORY_MISMATCH", (v) => { v.app.repoFullName = "seorilabs/happy-farm"; }],
    ["CANDIDATE_STATIC_REPOSITORY_MISMATCH", (v) => { v.registration.lastDefaultPushSha = "e".repeat(40); }],
    ["CANDIDATE_STATIC_REPOSITORY_MISMATCH", (v) => { v.registration.lastReconciledSha = "e".repeat(40); }],
    ["CANDIDATE_STATIC_REPOSITORY_MISMATCH", (v) => { v.registration.defaultBranch = "develop"; }],
    ["CANDIDATE_STATIC_BUNDLE_MISMATCH", (v) => { v.record.approvalState = "APPROVED"; }],
    ["CANDIDATE_STATIC_BUNDLE_MISMATCH", (v) => { v.record.workflowExecutionSha = "e".repeat(40); }],
    ["CANDIDATE_STATIC_BUNDLE_MISMATCH", (v) => { v.query.workflowBundleDigest = `sha256:${"e".repeat(64)}`; }],
    ["WORKFLOW_BUNDLE_REGISTRY_PROVENANCE_INVALID", (v) => { v.record.artifactRunAttempt = 2; }],
    ["WORKFLOW_BUNDLE_REGISTRY_PROVENANCE_INVALID", (v) => { v.record.contractDigestsDigest = `sha256:${"e".repeat(64)}`; }],
    ["CANDIDATE_STATIC_ACTIVE_BINDING_MISMATCH", (v) => { v.payload.build.workflowBundleDigest = `sha256:${"e".repeat(64)}`; v.resign(); }],
    ["CANDIDATE_STATIC_ACTIVE_BINDING_MISMATCH", (v) => { v.discovery.workflowProfile = "react-native"; }],
    ["WORKFLOW_BUNDLE_NOT_APPROVED", (v) => { v.payload.build.workflowBundleSha = "e".repeat(40); v.resign(); }],
    ["INVALID_CONFIG_SIGNATURE", (v) => { v.revision.snapshotSignature = "e".repeat(64); }],
  ];
  for (const [code, mutate] of cases) {
    const value = fixture(); mutate(value);
    await assert.rejects(() => read(value), (error: unknown) => error instanceof ControlPlaneError && error.code === code, code);
  }
});

test("없는 기록은 404이고, 만료된 감사 예외와 없는 ACTIVE/discovery는 기존 서버 오류를 유지한다", async () => {
  for (const missing of ["app", "registration", "record"] as const) {
    const value = fixture(); value.stored[missing] = null;
    await assert.rejects(() => read(value), (error: unknown) => error instanceof ControlPlaneError
      && controlPlaneErrorResponse(error).status === 404 && error.code === "CANDIDATE_STATIC_BINDING_NOT_FOUND");
  }
  for (const [missing, code] of [["revision", "NO_ACTIVE_CONFIG"], ["discovery", "NO_DISCOVERY_FOR_SHA"]] as const) {
    const value = fixture(); value.stored[missing] = null;
    await assert.rejects(() => read(value), (error: unknown) => error instanceof ControlPlaneError && error.code === code);
  }
  await assert.rejects(() => read(fixture(), { now: new Date("2026-10-03T00:00:00Z") }), (error: unknown) =>
    error instanceof ControlPlaneError && error.code === "DEPENDENCY_AUDIT_EXCEPTION_EXPIRED" && controlPlaneErrorResponse(error).status === 409);
});

test("GET는 정상 admin principal만 받고 누락·중복·임의 ref·허용 밖 repo 입력을 400으로 거부한다", async () => {
  const names = ["CONTROL_PLANE_ADMIN_TOKEN", "CONTROL_PLANE_ADMIN_PRINCIPAL", "AGENT_WORKER_CODEX_TOKEN"] as const;
  const previous = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-candidate-static-admin-token";
  process.env.CONTROL_PLANE_ADMIN_PRINCIPAL = "backoffice:fleet-operator";
  process.env.AGENT_WORKER_CODEX_TOKEN = "test-candidate-static-worker-token";
  try {
    const route = await import("@/app/api/control-plane/candidate-static-binding/route");
    assert.equal("POST" in route, false);
    const query = new URLSearchParams(fixture().query);
    const url = `https://backoffice.vzyx.xyz/api/control-plane/candidate-static-binding?${query}`;
    const headers = { authorization: "Bearer test-candidate-static-admin-token", "x-seori-principal": "backoffice:fleet-operator" };
    assert.equal((await route.GET(new NextRequest(url))).status, 401);
    assert.equal((await route.GET(new NextRequest(url, { headers: { ...headers, "x-seori-principal": "codex:seorilabs-generic-worker" } }))).status, 401);
    assert.equal((await route.GET(new NextRequest(url, { headers: { ...headers, authorization: "Bearer test-candidate-static-worker-token" } }))).status, 401);
    for (const bad of [url + "&ref=main", url + `&sourceSha=${SOURCE}`, url.replace(REPO_ID, "7001"), url.replace(SOURCE, "main"), url.split("?")[0]!]) {
      assert.equal((await route.GET(new NextRequest(bad, { headers }))).status, 400);
    }
  } finally {
    for (const key of names) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
