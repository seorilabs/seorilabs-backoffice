import assert from "node:assert/strict";
import test from "node:test";
import type { DependencyAuditException } from "@/lib/control-plane/contracts";
import type { GitHubActionsStaticManifestIdentity } from "@/lib/control-plane/github-actions-oidc";
import { jsonDigest, signSnapshot, type JsonValue } from "@/lib/control-plane/json";
import {
  ControlPlaneError,
  resolveStaticRuntimeManifest,
  resolveStaticRuntimeManifestForRepository,
} from "@/lib/control-plane/service";

const SIGNING_KEY = "unit-test-snapshot-signing-key";
const REPOSITORY_ID = "1250442131";
const FULL_NAME = "seorilabs/happy-farm";
const APPLICATION_SHA = "3d8c7f96eb6bb9ef47b3d5485cb5faf1408373a2";
const BINDING_SHA = "376c31350558c3ac4ed88907c4a35b0e443b5cd7";
const BUNDLE_SHA = "c".repeat(40);

function dependencyAuditException(): DependencyAuditException {
  return {
    schemaVersion: 1 as const,
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    bindings: [
      {
        actionClass: "STATIC_CHECK" as const,
        sourceSha: BINDING_SHA,
        lockfileSha256: "sha256:bb7c039ab9bb3b0deb3755e124a2f248f44b09c984cc12e1a5450686e18bd3c5",
      },
      {
        actionClass: "ANDROID_BUILD_ONLY" as const,
        sourceSha: BINDING_SHA,
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

function identity(
  overrides: Partial<GitHubActionsStaticManifestIdentity> = {},
): GitHubActionsStaticManifestIdentity {
  return {
    repositoryId: REPOSITORY_ID,
    fullName: FULL_NAME,
    applicationSourceSha: APPLICATION_SHA,
    bindingSourceSha: BINDING_SHA,
    workflowBundleSha: BUNDLE_SHA,
    calledWorkflowPath: ".github/workflows/js-static-checks-v1.yml",
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
  public?: boolean;
  workflowBundleSha?: string;
  requestHash?: string | null;
  sourceRef?: string | null;
  defaultBranch?: string;
  profile?: "react-native" | "capacitor" | "ait-web" | "godot";
  rootWorkspace?: boolean;
  dependencyAuditException?: ReturnType<typeof dependencyAuditException>;
  repositoryId?: string;
  fullName?: string;
} = {}) {
  const repositoryId = overrides.repositoryId ?? REPOSITORY_ID;
  const fullName = overrides.fullName ?? FULL_NAME;
  const defaultBranch = overrides.defaultBranch ?? "main";
  const sourceRef = overrides.sourceRef === undefined
    ? `refs/heads/${defaultBranch}`
    : overrides.sourceRef;
  const payload = {
    schemaVersion: 1,
    markets: [],
    build: {
      workflowBundleSha: overrides.workflowBundleSha ?? BUNDLE_SHA,
      ...(overrides.dependencyAuditException
        ? { dependencyAuditException: overrides.dependencyAuditException }
        : {}),
    },
  };
  const snapshot = {
    schemaVersion: 1,
    appId: "app-runtime-1",
    repoId: repositoryId,
    repoFullName: fullName,
    revision: 7,
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
          id: "app-runtime-1",
          repoId: BigInt(repositoryId),
          repoFullName: fullName,
          status: "ACTIVE" as const,
          isPublicRepo: overrides.public ?? false,
        };
      },
    },
    configRevision: {
      async findFirst() {
        return {
          id: "config-runtime-1",
          appId: "app-runtime-1",
          revision: 7,
          status: "ACTIVE" as const,
          payload,
          payloadHash: jsonDigest(payload as JsonValue),
          activatedSnapshot: snapshot,
          snapshotDigest: signed.digest,
          snapshotSignature: signed.signature,
        };
      },
    },
    discoveryObservation: {
      async findFirst() {
        return {
          id: "observation-runtime-1",
          sourceSha: BINDING_SHA,
          sourceRef,
          requestHash: overrides.requestHash === undefined
            ? "d".repeat(64)
            : overrides.requestHash,
          workflowProfile: overrides.profile ?? "capacitor",
          workflowPackageManager: overrides.profile === "godot" ? null : "pnpm",
          workflowWorkingDirectory: overrides.profile === "godot" ? "." : "app",
          payload: overrides.rootWorkspace
            ? {
                schemaVersion: 2,
                contractVersion: "repository-discovery/v7",
                repository: {
                  id: Number(repositoryId),
                  fullName,
                  sourceSha: BINDING_SHA,
                  sourceRef,
                },
                sources: ["package.json", "pnpm-lock.yaml"].map((path) => ({
                  path,
                  status: "PRESENT",
                  reason: null,
                  repoId: Number(repositoryId),
                  fullName,
                  sourceSha: BINDING_SHA,
                  sourceRef,
                  blobSha: "e".repeat(40),
                  contentSha256: "f".repeat(64),
                })),
              }
            : {},
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

test("Godot은 전용 v3 workflow identity와 null package manager일 때만 resolve된다", async () => {
  const result = await resolveStaticRuntimeManifest(input(identity({
    calledWorkflowPath: ".github/workflows/godot-checks-v3.yml",
  })), client({ profile: "godot" }) as never);
  assert.equal(result.manifest.staticBinding.profile, "godot");
  assert.equal(result.manifest.staticBinding.packageManager, null);
  assert.equal(result.manifest.staticBinding.workspaceRoot, ".");
});

test("called workflow path와 discovery profile 교차 대체는 fail-closed한다", async () => {
  for (const value of [
    {
      identity: identity({ calledWorkflowPath: ".github/workflows/js-static-checks-v1.yml" }),
      client: client({ profile: "godot" }),
    },
    {
      identity: identity({ calledWorkflowPath: ".github/workflows/godot-checks-v3.yml" }),
      client: client({ profile: "react-native" }),
    },
  ]) {
    await assert.rejects(
      () => resolveStaticRuntimeManifest(input(value.identity), value.client as never),
      (error) => error instanceof ControlPlaneError
        && error.code === "STATIC_WORKFLOW_PROFILE_MISMATCH",
    );
  }
});

test("static runtime resolver는 App, ACTIVE config, exact discovery와 approved bundle을 함께 결합한다", async () => {
  const result = await resolveStaticRuntimeManifest(input(), client() as never);
  assert.equal(result.state, "VERIFIED");
  assert.equal(result.repositoryId, REPOSITORY_ID);
  assert.equal(result.bindingSourceSha, BINDING_SHA);
  assert.equal(result.applicationSourceSha, APPLICATION_SHA);
  assert.equal(result.manifest.staticBinding.profile, "capacitor");
  assert.equal(result.manifest.staticBinding.workspaceRoot, "app");
});

test("static runtime은 signed snapshot의 exact base-source 예외를 digest에 포함한다", async () => {
  const exception = dependencyAuditException();
  const result = await resolveStaticRuntimeManifest(
    input(),
    client({ dependencyAuditException: exception }) as never,
  );
  assert.deepEqual(result.manifest.dependencyAuditException, exception);
  assert.equal(result.manifestDigest, `sha256:${jsonDigest(result.manifest as unknown as JsonValue)}`);
});

test("static dependency audit 예외는 identity, source, expiry와 clock drift를 fail-closed한다", async () => {
  const exception = dependencyAuditException();
  const cases = [
    {
      identity: identity({ repositoryId: "7001", fullName: "seorilabs/runtime-canary" }),
      client: client({
        dependencyAuditException: exception,
        repositoryId: "7001",
        fullName: "seorilabs/runtime-canary",
      }),
      now: new Date("2026-08-30T00:00:00Z"),
      code: "DEPENDENCY_AUDIT_EXCEPTION_IDENTITY_MISMATCH",
    },
    {
      identity: identity({ bindingSourceSha: "f".repeat(40) }),
      client: client({ dependencyAuditException: exception }),
      now: new Date("2026-08-30T00:00:00Z"),
      code: "DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH",
    },
    {
      identity: identity(),
      client: client({ dependencyAuditException: exception }),
      now: new Date("2026-09-13T00:00:00Z"),
      code: "DEPENDENCY_AUDIT_EXCEPTION_EXPIRED",
    },
    {
      identity: identity(),
      client: client({ dependencyAuditException: exception }),
      now: new Date(Number.NaN),
      code: "DEPENDENCY_AUDIT_EXCEPTION_CLOCK_INVALID",
    },
  ];
  for (const value of cases) {
    await assert.rejects(
      () => resolveStaticRuntimeManifest(input(value.identity, value.now), value.client as never),
      (error) => error instanceof ControlPlaneError && error.code === value.code,
    );
  }
});

test("static runtime resolver는 registered non-main default branch/ref를 그대로 반환한다", async () => {
  const result = await resolveStaticRuntimeManifest(
    input(identity({ defaultBranch: "develop" })),
    client({ defaultBranch: "develop" }) as never,
  );
  assert.equal(result.state, "VERIFIED");
  assert.equal(result.manifest.sourceRef, "refs/heads/develop");
});

test("root lockfile provenance가 있으면 monorepo workspace와 하위 command directory를 분리한다", async () => {
  const result = await resolveStaticRuntimeManifest(
    input(),
    client({ profile: "react-native", rootWorkspace: true }) as never,
  );
  assert.equal(result.manifest.staticBinding.workspaceRoot, ".");
  assert.equal(result.manifest.staticBinding.commandDirectory, "app");
});

test("bundle drift, runner boundary와 source provenance 누락은 fail-closed한다", async () => {
  const cases: Array<{
    identity?: GitHubActionsStaticManifestIdentity;
    client: ReturnType<typeof client>;
    code: string;
  }> = [
    { client: client({ workflowBundleSha: "e".repeat(40) }), code: "WORKFLOW_BUNDLE_NOT_APPROVED" },
    {
      identity: identity({ repositoryVisibility: "public", runnerEnvironment: "github-hosted" }),
      client: client(),
      code: "RUNNER_TRUST_BOUNDARY_MISMATCH",
    },
    { client: client({ requestHash: null }), code: "DISCOVERY_PROVENANCE_INVALID" },
    { client: client({ sourceRef: "refs/heads/release" }), code: "DISCOVERY_PROVENANCE_INVALID" },
  ];
  for (const value of cases) {
    await assert.rejects(
      () => resolveStaticRuntimeManifest(input(value.identity), value.client as never),
      (error) => error instanceof ControlPlaneError && error.code === value.code,
    );
  }
});

test("OIDC 없는 서버 측 계획도 런타임과 같은 manifest를 만든다", async () => {
  // caller 반증기는 실행 주체가 없어 OIDC 신원을 만들 수 없다. manifest 내용은 app,
  // registration, ACTIVE revision, discovery에서만 나오므로 두 경로의 결과가 같아야 한다.
  const stub = client();
  const runtime = await resolveStaticRuntimeManifest(input(), stub as never);
  const planned = await resolveStaticRuntimeManifestForRepository({
    selector: {
      repositoryId: REPOSITORY_ID,
      bindingSourceSha: BINDING_SHA,
      applicationSourceSha: APPLICATION_SHA,
      workflowBundleSha: BUNDLE_SHA,
    },
    app: { id: "app-runtime-1", repoFullName: FULL_NAME, status: "ACTIVE" },
    expectedSourceRef: "refs/heads/main",
    signingKey: SIGNING_KEY,
    snapshotSignatureKeyId: "control-plane-snapshot-v1",
    snapshotSignaturePolicyRevision: "snapshot-policy-v1",
    now: new Date("2026-08-30T00:00:00Z"),
  }, stub as never);

  assert.deepEqual(planned, runtime);
  assert.equal(planned.manifestDigest, runtime.manifestDigest);
});

test("서버 측 계획도 ACTIVE 설정이 승인하지 않은 번들은 거부한다", async () => {
  await assert.rejects(
    resolveStaticRuntimeManifestForRepository({
      selector: {
        repositoryId: REPOSITORY_ID,
        bindingSourceSha: BINDING_SHA,
        applicationSourceSha: APPLICATION_SHA,
        workflowBundleSha: "d".repeat(40),
      },
      app: { id: "app-runtime-1", repoFullName: FULL_NAME, status: "ACTIVE" },
      expectedSourceRef: "refs/heads/main",
      signingKey: SIGNING_KEY,
      snapshotSignatureKeyId: "control-plane-snapshot-v1",
      snapshotSignaturePolicyRevision: "snapshot-policy-v1",
      now: new Date("2026-08-30T00:00:00Z"),
    }, client() as never),
    (error) => error instanceof ControlPlaneError
      && error.code === "WORKFLOW_BUNDLE_NOT_APPROVED",
  );
});

test("런타임 경로는 OIDC 검사를 그대로 유지한다", async () => {
  // 분리 뒤에도 실행 주체 검증이 계획 경로로 새어 나가지 않는지 고정한다.
  await assert.rejects(
    resolveStaticRuntimeManifest(
      input(identity({ repositoryVisibility: "public" })),
      client() as never,
    ),
    (error) => error instanceof ControlPlaneError
      && error.code === "RUNNER_TRUST_BOUNDARY_MISMATCH",
  );
});
