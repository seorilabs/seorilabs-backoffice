import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildResolvedWorkflowBindingReadback } from "@/lib/control-plane/resolved-workflow-binding";

const SNAPSHOT_SIGNATURE = "c".repeat(64);

function fixtureRepository(): { repoRoot: string; sourceSha: string; cleanup: () => void } {
  const repoRoot = mkdtempSync(join(tmpdir(), "resolved-binding-"));
  const write = (relative: string, content: string) => {
    const target = join(repoRoot, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
  };
  write("package.json", JSON.stringify({ name: "fixture", private: true }) + "\n");
  write("build.env", "APP_ID=fixture\n");
  write("scripts/build-android.sh", "#!/usr/bin/env bash\nexit 0\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@seorilabs.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@seorilabs.com",
    },
  });
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  return {
    repoRoot,
    sourceSha: git("rev-parse", "HEAD").trim(),
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

function readbackInput(sourceSha: string) {
  return {
    state: "ACTIVE" as const,
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    sourceSha,
    sourceRef: "refs/heads/main",
    observationId: "observation-fixture-1",
    observationRequestHash: "1".repeat(64),
    configRevisionId: "config-fixture-1",
    configRevision: 26,
    configRevisionPayloadHash: "2".repeat(64),
    signedSnapshotDigest: "3".repeat(64),
    snapshotSignature: SNAPSHOT_SIGNATURE,
    snapshotSignatureKeyId: "control-plane-snapshot-v1",
    snapshotSignaturePolicyRevision: "snapshot-policy-v1",
    staticBinding: {
      profile: "react-native" as const,
      packageManager: "pnpm" as const,
      workspaceRoot: ".",
      commandDirectory: ".",
    },
    buildBindings: [],
    workflowBundleBinding: {
      sourceSha: "3e9b2d9029b03224aa71f9cea9d253a5bdc404a5",
      payloadDigest: `sha256:${"4".repeat(64)}`,
    },
  };
}

function readback(sourceSha: string) {
  return buildResolvedWorkflowBindingReadback({
    ...readbackInput(sourceSha),
    buildBindings: [{
      target: "android",
      buildProfile: "react-native-android",
      packageManager: "pnpm",
      executionRoot: ".",
      dependencyRoot: ".",
      scriptPath: "scripts/build-android.sh",
      artifactKind: "android-aab",
    }],
  });
}

test("readback 최상위 provenance는 manifest 안의 값과 같다", () => {
  const envelope = readback("0".repeat(40));
  assert.equal(envelope.state, "VERIFIED");
  assert.equal(envelope.configRevisionId, envelope.manifest.configRevisionId);
  assert.equal(envelope.configRevisionDigest, envelope.manifest.configRevisionDigest);
  assert.equal(envelope.signedSnapshotDigest, envelope.manifest.signedSnapshotDigest);
  assert.equal(envelope.snapshotSignatureKeyId, envelope.manifest.snapshotSignature.keyId);
  assert.equal(
    envelope.snapshotSignaturePolicyRevision,
    envelope.manifest.snapshotSignature.policyRevision,
  );
  assert.equal(envelope.snapshotSignatureDigest, envelope.manifest.snapshotSignature.digest);
});

test("관측 build binding의 packageManager는 계약 문서에 남지 않는다", () => {
  const envelope = readback("0".repeat(40));
  assert.equal(envelope.manifest.buildBindings.length, 1);
  assert.ok(!("packageManager" in envelope.manifest.buildBindings[0]!));
});

test("기본 브랜치가 main이 아니면 계약 문서를 만들지 않는다", () => {
  assert.throws(
    () => buildResolvedWorkflowBindingReadback({
      ...readbackInput("0".repeat(40)),
      sourceRef: "refs/heads/develop",
    }),
    /RESOLVED_BINDING_SOURCE_REF_UNSUPPORTED/u,
  );
});

/**
 * 이 test가 계약과 Backoffice 사이의 유일한 실제 대조다. 중앙 구현이 schema, digest
 * 정규화, envelope 대조를 모두 다시 하므로 투영이 어긋나면 여기서 바로 깨진다.
 */
test("중앙 계약이 Backoffice resolved binding readback을 그대로 신뢰한다", async () => {
  const fixture = fixtureRepository();
  try {
    const contract = await import(
      "seorilabs-org-contracts/repo-contract/workflow-bundle-v5"
    ) as {
      loadResolvedWorkflowBindingV5: (
        context: { repositoryId: string; fullName: string; sourceSha: string },
        options: { trustedResolvedManifestReadback: (context: unknown) => Promise<unknown>; repoRoot: string },
      ) => Promise<object>;
    };
    const envelope = readback(fixture.sourceSha);
    const binding = await contract.loadResolvedWorkflowBindingV5({
      repositoryId: "1250442131",
      fullName: "seorilabs/happy-farm",
      sourceSha: fixture.sourceSha,
    }, {
      trustedResolvedManifestReadback: async () => envelope,
      repoRoot: fixture.repoRoot,
    });
    assert.equal(typeof binding, "object");
  } finally {
    fixture.cleanup();
  }
});
