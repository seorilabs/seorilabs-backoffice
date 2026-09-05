import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVED_CALLER_PATH,
  approvedCallerReconciliationCommand,
  approvedCallerReconciliationTaskSchema,
  buildApprovedCallerReconciliationTask,
  publicApprovedCallerReconciliationTask,
} from "@/lib/control-plane/approved-caller-reconciliation-contract";
import { generateApprovedCallerMutation } from "@/lib/control-plane/approved-caller-generator";
import { githubReadyPrMutationIntentDigest } from "@/lib/control-plane/github-ready-pr-adapter";
import { buildResolvedWorkflowBindingReadback } from "@/lib/control-plane/resolved-workflow-binding";
import { jsonDigest } from "@/lib/control-plane/json";

const REPOSITORY_ID = "1250442131";
const FULL_NAME = "seorilabs/happy-farm";
const SOURCE_SHA = "495acb43c796f9b3d9ea616982eeaa18d4142353";
const BUNDLE_SHA = "3e9b2d9029b03224aa71f9cea9d253a5bdc404a5";

function resolvedManifest() {
  return buildResolvedWorkflowBindingReadback({
    state: "ACTIVE",
    repositoryId: REPOSITORY_ID,
    fullName: FULL_NAME,
    sourceSha: SOURCE_SHA,
    sourceRef: "refs/heads/main",
    observationId: "observation-1",
    observationRequestHash: "1".repeat(64),
    configRevisionId: "config-26",
    configRevision: 26,
    configRevisionPayloadHash: "2".repeat(64),
    signedSnapshotDigest: "3".repeat(64),
    snapshotSignature: "4".repeat(64),
    snapshotSignatureKeyId: "control-plane-snapshot-v1",
    snapshotSignaturePolicyRevision: "snapshot-policy-v1",
    staticBinding: {
      profile: "react-native",
      packageManager: "pnpm",
      workspaceRoot: ".",
      commandDirectory: ".",
    },
    buildBindings: [],
    workflowBundleBinding: {
      sourceSha: BUNDLE_SHA,
      payloadDigest: `sha256:${"5".repeat(64)}`,
    },
  });
}

function task() {
  return buildApprovedCallerReconciliationTask({
    approvedBundle: {
      registryRecordId: "cmtmdpz310mrzt2013cc7apkw",
      sourceSha: BUNDLE_SHA,
      payloadDigest: `sha256:${"6".repeat(64)}`,
      approvalKeyId: "workflow-bundle-v5-20260902-145012ae1370",
      bundle: { schemaVersion: 2 },
    },
    repositoryId: REPOSITORY_ID,
    fullName: FULL_NAME,
    sourceSha: SOURCE_SHA,
    sourceRef: "refs/heads/main",
    defaultBranch: "main",
    callerPath: APPROVED_CALLER_PATH,
    resolvedManifest: resolvedManifest(),
    installationId: "12345678",
  });
}

test("task는 caller 본문 대신 계약 입력만 담는다", () => {
  const built = task();
  assert.equal(built.contract, "approved-caller-reconciliation-executor/v1");
  assert.equal(built.caller.path, ".github/workflows/org-contract.yml");
  assert.equal(built.repository.issueNumber, null);
  // 본문·파일 digest가 task에 있으면 규칙이 두 곳에 생긴다.
  assert.ok(!("files" in built.mutation));
  assert.ok(!("intentDigest" in built.mutation));
});

test("branch와 marker는 계획 identity에서 파생된다", () => {
  const built = task();
  const identity = built.github.expectedHeadRef.split("/").at(-1)!;
  assert.match(identity, /^[0-9a-f]{64}$/u);
  assert.equal(
    built.github.expectedHeadRef,
    `refs/heads/seori/approved-caller/${REPOSITORY_ID}/${BUNDLE_SHA.slice(0, 12)}/${identity}`,
  );
  assert.equal(
    built.github.expectedPullRequestMarker,
    `seori-run:approved-caller:${REPOSITORY_ID}:${identity}`,
  );
});

test("resolved binding이 대상 저장소와 다르면 task를 거부한다", () => {
  const built = task();
  assert.throws(() => approvedCallerReconciliationTaskSchema.parse({
    ...built,
    repository: { ...built.repository, sourceSha: "a".repeat(40) },
  }));
});

test("본문을 바꾸면 계획 digest와 branch가 함께 어긋난다", () => {
  const built = task();
  assert.throws(() => approvedCallerReconciliationTaskSchema.parse({
    ...built,
    mutation: { ...built.mutation, title: "다른 제목" },
  }));
});

test("공개 응답에는 승인 번들 본문이 나가지 않는다", () => {
  const publicTask = publicApprovedCallerReconciliationTask(task());
  assert.ok(!("bundle" in publicTask.approvedBundle));
  assert.equal(publicTask.mutation.title, "승인된 중앙 워크플로 caller를 맞춘다");
});

test("PR 본문은 adapter 예약 지시를 담지 않는다", () => {
  const built = task();
  assert.ok(!built.mutation.body.includes("seori-run:"));
  assert.doesNotMatch(built.mutation.body, /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#\d+/iu);
});

/**
 * 실행기가 계약에서 만든 caller로 계산한 intent digest는 adapter가 authorize에 쓰는 값과
 * 같아야 한다. 두 값이 갈리면 STEP_LEDGER binding이 열리지 않는다.
 */
test("실행기가 만든 mutation intent는 adapter 계산과 같다", async () => {
  const built = task();
  const caller = "# 생성된 caller\nname: Org Contract\n";
  const stub = {
    loadApprovedWorkflowBundleV5: async () => ({}),
    loadResolvedWorkflowBindingV5: async () => ({}),
    generateStaticCallerV5: () => caller,
    validateStaticCallerV5: () => ({ ok: true, diagnostics: [] as readonly string[] }),
  };
  const prepared = await generateApprovedCallerMutation({
    task: built,
    repoRoot: "/nonexistent",
    contract: stub as never,
    verifyBundle: async () => { throw new Error("stub"); },
  });
  assert.equal(prepared.files.length, 1);
  assert.equal(prepared.files[0]!.path, APPROVED_CALLER_PATH);
  assert.equal(prepared.files[0]!.contentSha256, jsonDigest(caller));
  const command = approvedCallerReconciliationCommand(built, "agent-session:test");
  assert.equal(
    prepared.mutationIntentDigest,
    githubReadyPrMutationIntentDigest(command, prepared.files),
  );
});
