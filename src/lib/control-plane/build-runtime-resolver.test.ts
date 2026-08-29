import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubActionsBuildManifestIdentity } from "@/lib/control-plane/github-actions-oidc";
import { canonicalJson, jsonDigest, signSnapshot, type JsonValue } from "@/lib/control-plane/json";
import {
  ControlPlaneError,
  resolveBuildRuntimeManifest,
} from "@/lib/control-plane/service";

const SIGNING_KEY = "unit-test-build-snapshot-signing-key";
const REPOSITORY_ID = "1250442131";
const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const BUNDLE_SHA = "c".repeat(40);

function sha256(value: JsonValue): string {
  return `sha256:${jsonDigest(value)}`;
}

function candidateBundle() {
  const payload = {
    schemaVersion: 2,
    bundleVersion: "5.0.0",
    source: {
      repository: "seorilabs/.github",
      sha: BUNDLE_SHA,
      workflowExecutionSha: BUNDLE_SHA,
    },
    quality: {
      contractDigests: { "contracts/a.json": `sha256:${"1".repeat(64)}` },
      runtimeAssetDigests: {
        ".github/cloud-build/rn-android-build-only.yaml": `sha256:${"2".repeat(64)}`,
        ".github/cloud-build/godot-android-build-only.yaml": `sha256:${"3".repeat(64)}`,
      },
    },
    promotionScope: {
      staticProfiles: ["react-native", "godot", "capacitor", "ait-web"],
      buildProfiles: ["react-native-android", "godot-android"],
    },
    staticRuntimeBinding: {},
    buildRuntimeBinding: {},
    staticProfiles: {
      "react-native": { path: ".github/workflows/js-static-checks-v1.yml", runtime: "react-native", sha: BUNDLE_SHA },
      godot: { path: ".github/workflows/godot-checks-v3.yml", runtime: "godot", sha: BUNDLE_SHA },
      capacitor: { path: ".github/workflows/js-static-checks-v1.yml", runtime: "capacitor", sha: BUNDLE_SHA },
      "ait-web": { path: ".github/workflows/js-static-checks-v1.yml", runtime: "ait-web", sha: BUNDLE_SHA },
    },
    buildProfiles: {
      "react-native-android": {
        target: "android",
        executor: "cloud-build-x64",
        workflow: ".github/workflows/rn-build-android-cloud-v2.yml",
        artifactKind: "android-aab",
        scriptPath: "scripts/build-android.sh",
        builderImage: `builder/rn@sha256:${"4".repeat(64)}`,
        sha: BUNDLE_SHA,
      },
      "godot-android": {
        target: "android",
        executor: "cloud-build-x64",
        workflow: ".github/workflows/godot-build-android-cloud-v2.yml",
        artifactKind: "android-aab",
        scriptPath: "scripts/build-android.sh",
        builderImage: `builder/godot@sha256:${"5".repeat(64)}`,
        sha: BUNDLE_SHA,
      },
    },
    actions: {},
    runners: {},
    toolchains: {},
    callerPolicies: {},
    lifecyclePolicy: {},
    approval: { state: "CANDIDATE", evidence: [] },
  };
  return {
    ...payload,
    integrity: { algorithm: "sha256", payloadDigest: sha256(payload as JsonValue) },
  };
}

const bundle = candidateBundle();
const bundleDigest = (bundle.integrity as { payloadDigest: string }).payloadDigest;

function identity(
  overrides: Partial<GitHubActionsBuildManifestIdentity> = {},
): GitHubActionsBuildManifestIdentity {
  return {
    mode: "CANDIDATE",
    repositoryId: REPOSITORY_ID,
    fullName: "seorilabs/happy-farm",
    applicationSourceSha: SOURCE_SHA,
    eventSourceSha: EVENT_SHA,
    workflowBundleSha: BUNDLE_SHA,
    buildProfile: "react-native-android",
    calledWorkflowPath: ".github/workflows/rn-build-android-cloud-v2.yml",
    runId: "1234",
    runAttempt: "1",
    eventName: "pull_request",
    eventRef: "refs/pull/91/merge",
    repositoryVisibility: "private",
    runnerEnvironment: "self-hosted",
    ...overrides,
  };
}

function client(overrides: {
  appStatus?: "ACTIVE" | "PAUSED" | "DEPRECATED";
  configDigest?: string | null;
  registry?: boolean;
  buildBindings?: unknown;
  unsignedConfigDigest?: string;
} = {}) {
  const payload = {
    schemaVersion: 1,
    markets: [],
    build: {
      workflowBundleSha: BUNDLE_SHA,
      ...(overrides.configDigest === null
        ? {}
        : { workflowBundleDigest: overrides.configDigest ?? bundleDigest }),
    },
  };
  const storedPayload = overrides.unsignedConfigDigest
    ? {
        ...payload,
        build: { ...payload.build, workflowBundleDigest: overrides.unsignedConfigDigest },
      }
    : payload;
  const snapshot = {
    schemaVersion: 1,
    appId: "app-build-1",
    repoId: REPOSITORY_ID,
    repoFullName: "seorilabs/happy-farm",
    revision: 2,
    payloadHash: jsonDigest(payload as JsonValue),
    payload,
    activatedAt: "2026-08-29T00:00:00.000Z",
  };
  const signed = signSnapshot(snapshot as JsonValue, SIGNING_KEY);
  return {
    app: {
      async findUnique() {
        return {
          id: "app-build-1",
          repoId: BigInt(REPOSITORY_ID),
          repoFullName: "seorilabs/happy-farm",
          status: overrides.appStatus ?? "ACTIVE",
          isPublicRepo: false,
        };
      },
    },
    configRevision: {
      async findFirst() {
        return {
          id: "config-build-1",
          revision: 2,
          status: "ACTIVE" as const,
          payload: storedPayload,
          payloadHash: jsonDigest(storedPayload as JsonValue),
          activatedSnapshot: snapshot,
          snapshotDigest: signed.digest,
          snapshotSignature: signed.signature,
        };
      },
    },
    workflowBundleRegistryRecord: {
      async findFirst() {
        if (overrides.registry === false) return null;
        return {
          id: "bundle-candidate-1",
          registryId: "seorilabs-workflow-bundles-v5",
          subject: `workflow-bundle-v5:${BUNDLE_SHA}`,
          approvalState: "CANDIDATE" as const,
          sourceSha: BUNDLE_SHA,
          workflowExecutionSha: BUNDLE_SHA,
          bundleVersion: "5.0.0",
          payloadDigest: bundleDigest,
          candidateDigest: null,
          contractDigestsDigest: sha256((bundle.quality as { contractDigests: JsonValue }).contractDigests),
          runtimeAssetDigestsDigest: sha256((bundle.quality as { runtimeAssetDigests: JsonValue }).runtimeAssetDigests),
          evidenceDigest: null,
          approvalPayloadDigest: null,
          approvalKeyId: null,
          approvalPolicyRevision: null,
          bundle,
          artifactRepository: "seorilabs/.github",
          artifactRepositoryId: 1241442018n,
          artifactWorkflowPath: ".github/workflows/workflow-bundle-v5-candidate.yml",
          artifactRunId: 777n,
          artifactRunAttempt: 1,
          artifactId: 888n,
          artifactName: `workflow-bundle-v5-candidate-${BUNDLE_SHA}`,
          artifactDigest: `sha256:${"6".repeat(64)}`,
          approvalSlot: null,
          requestHash: jsonDigest({
            mode: "CANDIDATE",
            sourceSha: BUNDLE_SHA,
            runId: "777",
            runAttempt: 1,
            artifactId: "888",
          }),
          idempotencyKey: "candidate-import:test",
          observedBy: "test",
          createdAt: new Date(),
        };
      },
    },
    discoveryObservation: {
      async findFirst() {
        return {
          id: "observation-build-1",
          sourceSha: SOURCE_SHA,
          sourceRef: "refs/heads/main",
          requestHash: "8".repeat(64),
          buildBindings: overrides.buildBindings === undefined
            ? [{
                target: "android",
                buildProfile: "react-native-android",
                packageManager: "pnpm",
                executionRoot: ".",
                dependencyRoot: ".",
                scriptPath: "scripts/build-android.sh",
                artifactKind: "android-aab",
              }]
            : overrides.buildBindings,
        };
      },
    },
  };
}

const input = (value = identity()) => ({
  identity: value,
  signingKey: SIGNING_KEY,
  snapshotSignatureKeyId: "control-plane-snapshot-v1",
  snapshotSignaturePolicyRevision: "snapshot-policy-v1",
});

test("build canary resolver는 ACTIVE config, durable artifact registry와 별도 root fact를 결합한다", async () => {
  const result = await resolveBuildRuntimeManifest(input(), client() as never);
  assert.equal(result.state, "VERIFIED");
  assert.equal(result.mode, "CANDIDATE");
  assert.equal(result.applicationSourceSha, SOURCE_SHA);
  assert.equal(result.eventSourceSha, EVENT_SHA);
  assert.equal(result.manifest.workflowBundle.payloadDigest, bundleDigest);
  assert.deepEqual(result.manifest.buildBinding, {
    target: "android",
    buildProfile: "react-native-android",
    packageManager: "pnpm",
    executionRoot: ".",
    dependencyRoot: ".",
    scriptPath: "scripts/build-android.sh",
    artifactKind: "android-aab",
  });
});

test("config SHA 단독 주장, registry 부재와 build observation 누락은 fail-closed한다", async () => {
  for (const value of [
    { client: client({ configDigest: null }), code: "WORKFLOW_BUNDLE_BINDING_MISSING" },
    { client: client({ registry: false }), code: "WORKFLOW_BUNDLE_REGISTRY_READBACK_MISSING" },
    { client: client({ buildBindings: null }), code: "BUILD_BINDING_OBSERVATION_MISSING" },
    { client: client({ appStatus: "PAUSED" }), code: "PAUSED_BUILD_RUNTIME_FORBIDDEN" },
  ]) {
    await assert.rejects(
      () => resolveBuildRuntimeManifest(input(), value.client as never),
      (error) => error instanceof ControlPlaneError && error.code === value.code,
    );
  }
});

test("registry digest가 config binding과 다르면 self-asserted SHA로 build를 열 수 없다", async () => {
  await assert.rejects(
    () => resolveBuildRuntimeManifest(
      input(),
      client({ configDigest: `sha256:${"f".repeat(64)}` }) as never,
    ),
    (error) => error instanceof ControlPlaneError
      && error.code === "WORKFLOW_BUNDLE_REGISTRY_READBACK_MISSING",
  );
});

test("서명 snapshot 밖에서 바뀐 config binding은 registry가 있어도 거부한다", async () => {
  await assert.rejects(
    () => resolveBuildRuntimeManifest(
      input(),
      client({ unsignedConfigDigest: `sha256:${"f".repeat(64)}` }) as never,
    ),
    (error) => error instanceof ControlPlaneError && error.code === "INVALID_CONFIG_SIGNATURE",
  );
});

test("manifest digest는 canonical JSON과 정확히 일치한다", async () => {
  const result = await resolveBuildRuntimeManifest(input(), client() as never);
  assert.equal(result.manifestDigest, `sha256:${jsonDigest(result.manifest as unknown as JsonValue)}`);
  assert.equal(canonicalJson(result.manifest as unknown as JsonValue).includes(SIGNING_KEY), false);
});
