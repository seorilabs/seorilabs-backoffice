import assert from "node:assert/strict";
import test from "node:test";

import type { DependencyAuditException } from "@/lib/control-plane/contracts";
import type { GitHubActionsBuildManifestIdentity } from "@/lib/control-plane/github-actions-oidc";
import { canonicalJson, jsonDigest, signSnapshot, type JsonValue } from "@/lib/control-plane/json";
import {
  ControlPlaneError,
  resolveBuildRuntimeManifest,
} from "@/lib/control-plane/service";

const SIGNING_KEY = "unit-test-build-snapshot-signing-key";
const REPOSITORY_ID = "1250442131";
const SOURCE_SHA = "376c31350558c3ac4ed88907c4a35b0e443b5cd7";
const STATIC_SOURCE_SHA = "3d8c7f96eb6bb9ef47b3d5485cb5faf1408373a2";
const EVENT_SHA = "b".repeat(40);
const BUNDLE_SHA = "c".repeat(40);

function dependencyAuditException(): DependencyAuditException {
  return {
    schemaVersion: 1 as const,
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    bindings: [
      {
        actionClass: "STATIC_CHECK" as const,
        sourceSha: STATIC_SOURCE_SHA,
        lockfileSha256: "sha256:bb7c039ab9bb3b0deb3755e124a2f248f44b09c984cc12e1a5450686e18bd3c5",
      },
      {
        actionClass: "ANDROID_BUILD_ONLY" as const,
        sourceSha: SOURCE_SHA,
        lockfileSha256: "sha256:bb0676484da96a39896ceefa3f74b047eab4705dc3f81c87a31ffb88fdd0b1a8",
      },
    ],
    expiresAt: "2026-09-13T00:00:00Z",
    reason: "공식 패치 대기 중인 build-time dependency advisory 3건",
    advisories: [
      { ghsa: "GHSA-2p57-rm9w-gvfp", module: "ip", severity: "high" as const, versions: ["1.1.9"] },
      { ghsa: "GHSA-5p2g-fcmc-qvqq", module: "image-size", severity: "high" as const, versions: ["0.6.3", "1.2.1"] },
      { ghsa: "GHSA-w3rx-r6r6-pgpr", module: "image-size", severity: "high" as const, versions: ["0.6.3", "1.2.1"] },
    ],
  };
}

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
    defaultBranch: "main",
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
  defaultBranch?: string;
  dependencyAuditException?: ReturnType<typeof dependencyAuditException>;
  unsignedDependencyAuditException?: ReturnType<typeof dependencyAuditException>;
} = {}) {
  const defaultBranch = overrides.defaultBranch ?? "main";
  const payload = {
    schemaVersion: 1,
    markets: [],
    build: {
      workflowBundleSha: BUNDLE_SHA,
      ...(overrides.configDigest === null
        ? {}
        : { workflowBundleDigest: overrides.configDigest ?? bundleDigest }),
      ...(overrides.dependencyAuditException
        ? { dependencyAuditException: overrides.dependencyAuditException }
        : {}),
    },
  };
  const storedPayload = overrides.unsignedConfigDigest || overrides.unsignedDependencyAuditException
    ? {
        ...payload,
        build: {
          ...payload.build,
          ...(overrides.unsignedConfigDigest
            ? { workflowBundleDigest: overrides.unsignedConfigDigest }
            : {}),
          ...(overrides.unsignedDependencyAuditException
            ? { dependencyAuditException: overrides.unsignedDependencyAuditException }
            : {}),
        },
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
    repositoryRegistration: {
      async findUnique() {
        return { defaultBranch, archived: false };
      },
    },
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
          sourceRef: `refs/heads/${defaultBranch}`,
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

const input = (value = identity(), now = new Date("2026-08-30T00:00:00Z")) => ({
  identity: value,
  signingKey: SIGNING_KEY,
  snapshotSignatureKeyId: "control-plane-snapshot-v1",
  snapshotSignaturePolicyRevision: "snapshot-policy-v1",
  now,
});

test("build canary resolver는 ACTIVE config, durable artifact registry와 별도 root fact를 결합한다", async () => {
  const result = await resolveBuildRuntimeManifest(input(), client() as never);
  assert.equal(result.state, "VERIFIED");
  assert.equal(result.mode, "CANDIDATE");
  assert.equal(result.applicationSourceSha, SOURCE_SHA);
  assert.equal(result.eventSourceSha, EVENT_SHA);
  assert.equal(result.manifest.workflowBundle.payloadDigest, bundleDigest);
  assert.equal("dependencyAuditException" in result.manifest, false);
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

test("build-only runtime은 signed snapshot의 exact base-source 예외를 digest에 포함한다", async () => {
  const exception = dependencyAuditException();
  const result = await resolveBuildRuntimeManifest(
    input(),
    client({ dependencyAuditException: exception }) as never,
  );
  assert.deepEqual(result.manifest.dependencyAuditException, exception);
  assert.equal(result.manifestDigest, `sha256:${jsonDigest(result.manifest as unknown as JsonValue)}`);
});

test("build-only dependency audit 예외는 source, expiry와 clock drift를 fail-closed한다", async () => {
  const exception = dependencyAuditException();
  const cases = [
    {
      identity: identity({ applicationSourceSha: "f".repeat(40) }),
      now: new Date("2026-08-30T00:00:00Z"),
      code: "DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH",
    },
    {
      identity: identity(),
      now: new Date("2026-09-13T00:00:00Z"),
      code: "DEPENDENCY_AUDIT_EXCEPTION_EXPIRED",
    },
    {
      identity: identity(),
      now: new Date(Number.NaN),
      code: "DEPENDENCY_AUDIT_EXCEPTION_CLOCK_INVALID",
    },
  ];
  for (const value of cases) {
    await assert.rejects(
      () => resolveBuildRuntimeManifest(
        input(value.identity, value.now),
        client({ dependencyAuditException: exception }) as never,
      ),
      (error) => error instanceof ControlPlaneError && error.code === value.code,
    );
  }
});

test("build resolver는 registered non-main default branch/ref를 그대로 반환한다", async () => {
  const result = await resolveBuildRuntimeManifest(
    input(identity({ defaultBranch: "develop" })),
    client({ defaultBranch: "develop" }) as never,
  );
  assert.equal(result.state, "VERIFIED");
  assert.equal(result.manifest.sourceRef, "refs/heads/develop");
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

test("signed snapshot 밖에서 추가한 dependency audit 예외는 manifest에 포함하지 않는다", async () => {
  await assert.rejects(
    () => resolveBuildRuntimeManifest(
      input(),
      client({ unsignedDependencyAuditException: dependencyAuditException() }) as never,
    ),
    (error) => error instanceof ControlPlaneError && error.code === "INVALID_CONFIG_SIGNATURE",
  );
});

test("manifest digest는 canonical JSON과 정확히 일치한다", async () => {
  const result = await resolveBuildRuntimeManifest(input(), client() as never);
  assert.equal(result.manifestDigest, `sha256:${jsonDigest(result.manifest as unknown as JsonValue)}`);
  assert.equal(canonicalJson(result.manifest as unknown as JsonValue).includes(SIGNING_KEY), false);
});
