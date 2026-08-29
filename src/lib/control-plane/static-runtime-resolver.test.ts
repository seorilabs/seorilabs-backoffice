import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubActionsStaticManifestIdentity } from "@/lib/control-plane/github-actions-oidc";
import { jsonDigest, signSnapshot, type JsonValue } from "@/lib/control-plane/json";
import {
  ControlPlaneError,
  resolveStaticRuntimeManifest,
} from "@/lib/control-plane/service";

const SIGNING_KEY = "unit-test-snapshot-signing-key";
const REPOSITORY_ID = "7001";
const APPLICATION_SHA = "a".repeat(40);
const BINDING_SHA = "b".repeat(40);
const BUNDLE_SHA = "c".repeat(40);

function identity(
  overrides: Partial<GitHubActionsStaticManifestIdentity> = {},
): GitHubActionsStaticManifestIdentity {
  return {
    repositoryId: REPOSITORY_ID,
    fullName: "seorilabs/runtime-canary",
    applicationSourceSha: APPLICATION_SHA,
    bindingSourceSha: BINDING_SHA,
    workflowBundleSha: BUNDLE_SHA,
    calledWorkflowPath: ".github/workflows/js-static-checks-v1.yml",
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
  public?: boolean;
  workflowBundleSha?: string;
  requestHash?: string | null;
  sourceRef?: string | null;
  profile?: "react-native" | "capacitor" | "ait-web" | "godot";
} = {}) {
  const payload = {
    schemaVersion: 1,
    markets: [],
    build: { workflowBundleSha: overrides.workflowBundleSha ?? BUNDLE_SHA },
  };
  const snapshot = {
    schemaVersion: 1,
    appId: "app-runtime-1",
    repoId: REPOSITORY_ID,
    repoFullName: "seorilabs/runtime-canary",
    revision: 7,
    payloadHash: jsonDigest(payload as JsonValue),
    payload,
    activatedAt: "2026-08-29T00:00:00.000Z",
  };
  const signed = signSnapshot(snapshot as JsonValue, SIGNING_KEY);
  return {
    app: {
      async findUnique() {
        return {
          id: "app-runtime-1",
          repoId: BigInt(REPOSITORY_ID),
          repoFullName: "seorilabs/runtime-canary",
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
          sourceRef: overrides.sourceRef === undefined
            ? "refs/heads/main"
            : overrides.sourceRef,
          requestHash: overrides.requestHash === undefined
            ? "d".repeat(64)
            : overrides.requestHash,
          workflowProfile: overrides.profile ?? "capacitor",
          workflowPackageManager: overrides.profile === "godot" ? null : "pnpm",
          workflowWorkingDirectory: overrides.profile === "godot" ? "." : "app",
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
