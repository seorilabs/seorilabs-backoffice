import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  deterministicGithubCommitSha,
  executeGithubReadyPr,
  observeGithubReadyPr,
  prepareGithubReadyPrCommand,
  recoverGithubReadyPr,
  type GithubCommitState,
  type GithubMutationControlPlane,
  type GithubPullRequestState,
  type GithubReadyPrPort,
} from "@/lib/control-plane/github-ready-pr-adapter";

const SOURCE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const NOW = new Date("2026-08-29T03:00:00.000Z");
const REPO = "seorilabs/example";

function command() {
  return {
    sessionId: "agent-session:fixture",
    repoId: "123",
    repoFullName: REPO,
    issueNumber: 7,
    sourceSha: SOURCE_SHA,
    title: "중앙 계약을 적용한다",
    body: "요청된 범위의 변경과 검증을 포함합니다.",
    commitMessage: "fix: 중앙 계약 적용",
    files: [{
      path: "src/example.ts",
      contentBase64: Buffer.from("export const enabled = true;\n", "utf8").toString("base64"),
      mode: "100644" as const,
    }],
  };
}

function manualPullRequest(number: number): GithubPullRequestState {
  return {
    number,
    nodeId: `PR_manual_${number}`,
    url: `https://github.com/${REPO}/pull/${number}`,
    state: "OPEN",
    draft: false,
    headRef: `refs/heads/manual-${number}`,
    headRepoFullName: REPO,
    headSha: number.toString(16).padStart(40, "0"),
    baseRef: "refs/heads/main",
    baseRepoFullName: REPO,
    baseSha: SOURCE_SHA,
    body: "manual change",
  };
}

class FakeGithub implements GithubReadyPrPort {
  readonly installationId = "101";
  readonly pageRequests: Array<{ state: "OPEN" | "ALL"; page: number }> = [];
  readonly writes: Array<"CREATE_COMMIT" | "CREATE_REF" | "CREATE_PR"> = [];
  repositoryReads = 0;
  defaultBranch = "main";
  defaultBranchSha = SOURCE_SHA;
  driftOnSecondRepositoryRead = false;
  renameDefaultBranchOnRead = Number.POSITIVE_INFINITY;
  createdPrBaseBranch: string | null = null;
  closeFirstAfterPageOne = false;
  commit: GithubCommitState | null = null;
  headSha: string | null = null;
  pulls: GithubPullRequestState[] = Array.from({ length: 100 }, (_, index) => manualPullRequest(index + 100));

  async getRepository() {
    this.repositoryReads += 1;
    if (this.driftOnSecondRepositoryRead && this.repositoryReads >= 2) this.defaultBranchSha = "c".repeat(40);
    if (this.repositoryReads >= this.renameDefaultBranchOnRead) this.defaultBranch = "trunk";
    return { id: 123, fullName: REPO, defaultBranch: this.defaultBranch, defaultBranchSha: this.defaultBranchSha };
  }

  async getIssue() {
    return {
      number: 7,
      nodeId: "I_fixture_7",
      state: "OPEN" as const,
      labels: ["autopilot", "P1"],
      updatedAt: NOW,
    };
  }

  async listPullRequests(input: { state: "OPEN" | "ALL"; page: number; perPage: number }) {
    this.pageRequests.push({ state: input.state, page: input.page });
    const visible = input.state === "OPEN" ? this.pulls.filter((pullRequest) => pullRequest.state === "OPEN") : this.pulls;
    const page = structuredClone(visible.slice((input.page - 1) * input.perPage, input.page * input.perPage));
    if (this.closeFirstAfterPageOne && input.page === 1 && this.pulls[0]) {
      this.pulls[0].state = "CLOSED";
    }
    return page;
  }

  async getRef(_repoFullName: string, ref: string) {
    return ref === "refs/heads/seori/run-fixture-1" && this.headSha ? { sha: this.headSha } : null;
  }

  async getCommit(_repoFullName: string, sha: string) {
    return this.commit?.sha === sha ? this.commit : null;
  }

  async createTree() {
    return { sha: TREE_SHA };
  }

  async createCommit(input: { sourceSha: string; treeSha: string; message: string; date: Date }) {
    const sha = deterministicGithubCommitSha({
      treeSha: input.treeSha,
      parentSha: input.sourceSha,
      message: input.message,
      date: input.date,
    });
    this.writes.push("CREATE_COMMIT");
    this.commit = { sha, treeSha: input.treeSha, parentSha: input.sourceSha };
    return { sha };
  }

  async createRef(input: { ref: string; sha: string }) {
    assert.equal(input.ref, "refs/heads/seori/run-fixture-1");
    this.writes.push("CREATE_REF");
    this.headSha = input.sha;
  }

  async createPullRequest(input: { baseBranch: string; headRef: string; title: string; body: string }) {
    assert.ok(this.headSha);
    this.writes.push("CREATE_PR");
    this.createdPrBaseBranch = input.baseBranch;
    this.pulls.push({
      number: 7,
      nodeId: "PR_fixture_7",
      url: `https://github.com/${REPO}/pull/7`,
      state: "OPEN",
      draft: false,
      headRef: input.headRef,
      headRepoFullName: REPO,
      headSha: this.headSha!,
      baseRef: `refs/heads/${input.baseBranch}`,
      baseRepoFullName: REPO,
      baseSha: SOURCE_SHA,
      body: input.body,
    });
  }
}

function controlPlane(input: {
  readbackStatus?: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN";
  onAuthorize?: (body: Record<string, unknown>) => void;
  onClaimRequest?: (requestId: string) => void;
  verifiedSteps?: boolean;
  crashBeforeCompletionStep?: "CREATE_COMMIT" | "CREATE_REF" | "CREATE_PR";
  claimConflictOnceStep?: "CREATE_COMMIT" | "CREATE_REF" | "CREATE_PR";
} = {}): GithubMutationControlPlane {
  let expectedTreeSha: string | null = input.verifiedSteps ? TREE_SHA : null;
  let expectedCommitSha: string | null = input.verifiedSteps
    ? deterministicGithubCommitSha({
      treeSha: TREE_SHA,
      parentSha: SOURCE_SHA,
      message: command().commitMessage,
      date: NOW,
    })
    : null;
  const verified = new Set<string>(input.verifiedSteps ? ["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"] : []);
  let crashPending = Boolean(input.crashBeforeCompletionStep);
  let claimConflictPending = Boolean(input.claimConflictOnceStep);
  return {
    recover: async () => {
      throw new Error("unexpected recovery claim");
    },
    authorize: async ({ body }) => {
      input.onAuthorize?.(body as unknown as Record<string, unknown>);
      return {
        executionId: "mutation-execution:fixture",
        action: "GITHUB_READY_PR_MUTATE",
        mutationIntentDigest: body.mutationIntentDigest,
        expectedHeadRef: "refs/heads/seori/run-fixture-1",
        expectedPullRequestMarker: "seori-run:fixture:1",
        expiresAt: new Date(NOW.getTime() + 60_000),
        commitDate: NOW,
        status: "CONSUMED",
        writeDisposition: "STEP_LEDGER",
        duplicate: false,
      };
    },
    claimStep: async ({ requestId, body }) => {
      input.onClaimRequest?.(requestId);
      if (claimConflictPending && input.claimConflictOnceStep === body.stepKind) {
        claimConflictPending = false;
        throw new Error("SEORI_BACKOFFICE_REJECTED_409");
      }
      return {
        executionId: body.executionId,
        stepId: `step:${body.stepKind}`,
        stepKind: body.stepKind,
        stepStatus: verified.has(body.stepKind) ? "VERIFIED" : expectedCommitSha && body.stepKind === "CREATE_COMMIT" ? "PLANNED" : "CLAIMED",
        generation: 1,
        attemptId: verified.has(body.stepKind) ? null : `attempt:${body.stepKind}`,
        expiresAt: verified.has(body.stepKind) ? null : new Date(NOW.getTime() + 60_000),
        expectedTreeSha,
        expectedCommitSha,
        expectedHeadRef: "refs/heads/seori/run-fixture-1",
        expectedPullRequestMarker: "seori-run:fixture:1",
        sourceSha: SOURCE_SHA,
        commitDate: NOW,
        writeDisposition: verified.has(body.stepKind)
          ? "ALREADY_VERIFIED" as const
          : expectedCommitSha && body.stepKind === "CREATE_COMMIT"
            ? "READBACK_THEN_EXECUTE" as const
            : "EXECUTE_ONCE" as const,
        duplicate: false,
      };
    },
    planStep: async ({ body }) => {
      expectedTreeSha = body.expectedTreeSha;
      expectedCommitSha = body.expectedCommitSha;
      return {
        executionId: body.executionId,
        stepId: body.stepId,
        attemptId: body.attemptId,
        generation: body.generation,
        status: "PLANNED",
        expectedTreeSha,
        expectedCommitSha,
        duplicate: false,
      };
    },
    completeStep: async ({ body }) => {
      if (crashPending && input.crashBeforeCompletionStep === body.stepKind) {
        crashPending = false;
        throw new Error("SIMULATED_PROCESS_CRASH");
      }
      const status = input.readbackStatus ?? "VERIFIED";
      if (status === "VERIFIED") verified.add(body.stepKind);
      return {
        executionId: body.executionId,
        stepId: body.stepId,
        attemptId: body.attemptId,
        generation: body.generation,
        status,
        duplicate: false,
      };
    },
    readback: async ({ body }) => ({
      executionId: body.executionId,
      status: input.readbackStatus ?? "VERIFIED",
      duplicate: false,
    }),
  };
}

test("step ledger adapter는 complete pagination 뒤 commit, ref, PR을 순서대로 한 번씩 생성한다", async () => {
  const github = new FakeGithub();
  let authorizedPrincipal = "";
  const result = await executeGithubReadyPr({
    operationId: "operation:fixture-1",
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: "d".repeat(64),
    rawCommand: command(),
    github,
    controlPlane: controlPlane({
      onAuthorize: (body) => {
        authorizedPrincipal = String(body.workerPrincipalId);
        assert.equal(body.workerRuntimeBindingDigest, "d".repeat(64));
        assert.match(String(body.mutationIntentDigest), /^[0-9a-f]{64}$/u);
      },
    }),
    clock: () => NOW,
  });
  assert.equal(authorizedPrincipal, "codex:seorilabs-generic-worker");
  assert.deepEqual(github.writes, ["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"]);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(result.pullRequestUrl, `https://github.com/${REPO}/pull/7`);
  assert.ok(github.pageRequests.some((request) => request.state === "ALL" && request.page === 2));
  assert.equal(github.pageRequests.some((request) => request.state === "OPEN"), false);
});

test("CREATE_PR 직전 default branch ref가 바뀌면 PR write를 거부한다", async () => {
  const github = new FakeGithub();
  github.renameDefaultBranchOnRead = 7;
  await executeGithubReadyPr({
    operationId: "operation:renamed-default-branch",
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: "d".repeat(64),
    rawCommand: command(),
    github,
    controlPlane: controlPlane({}),
    clock: () => NOW,
  });
  assert.deepEqual(github.writes, ["CREATE_COMMIT", "CREATE_REF"]);
  assert.equal(github.createdPrBaseBranch, null);
});

test("CREATE_COMMIT 직전 target ref가 생기면 tree와 commit write를 거부한다", async () => {
  const github = new FakeGithub();
  github.headSha = "e".repeat(40);
  await executeGithubReadyPr({
    operationId: "operation:preexisting-target-ref",
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: "d".repeat(64),
    rawCommand: command(),
    github,
    controlPlane: controlPlane({}),
    clock: () => NOW,
  });
  assert.deepEqual(github.writes, []);
});

test("이미 검증된 step replay는 GitHub write를 반복하지 않는다", async () => {
  const github = new FakeGithub();
  const headSha = deterministicGithubCommitSha({
    treeSha: TREE_SHA,
    parentSha: SOURCE_SHA,
    message: command().commitMessage,
    date: NOW,
  });
  github.commit = { sha: headSha, treeSha: TREE_SHA, parentSha: SOURCE_SHA };
  github.headSha = headSha;
  github.pulls.push({
    ...manualPullRequest(7),
    nodeId: "PR_fixture_7",
    headRef: "refs/heads/seori/run-fixture-1",
    headSha,
    body: "Closes #7\n\n<!-- seori-run:fixture:1 -->",
  });
  const result = await executeGithubReadyPr({
    operationId: "operation:fixture-duplicate",
    workerPrincipalId: "claude:seorilabs-generic-worker",
    workerRuntimeBindingDigest: "e".repeat(64),
    rawCommand: command(),
    github,
    controlPlane: controlPlane({ verifiedSteps: true }),
    clock: () => NOW,
  });
  assert.deepEqual(github.writes, []);
  assert.equal(result.status, "VERIFIED");
});

test("JIT 승인 뒤 default SHA나 target ref가 달라지면 write 없이 readback한다", async () => {
  const github = new FakeGithub();
  github.driftOnSecondRepositoryRead = true;
  const result = await executeGithubReadyPr({
    operationId: "operation:fixture-drift",
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: "d".repeat(64),
    rawCommand: command(),
    github,
    controlPlane: controlPlane({ readbackStatus: "NOT_APPLIED" }),
    clock: () => NOW,
  });
  assert.deepEqual(github.writes, []);
  assert.equal(result.writeAttempted, false);
  assert.equal(result.status, "NOT_APPLIED");
});

test("complete pre-write readback 중 JIT 승인이 만료되면 write 없이 readback한다", async () => {
  const github = new FakeGithub();
  let clockCalls = 0;
  const result = await executeGithubReadyPr({
    operationId: "operation:fixture-expired-after-readback",
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: "d".repeat(64),
    rawCommand: command(),
    github,
    controlPlane: controlPlane({ readbackStatus: "NOT_APPLIED" }),
    clock: () => {
      clockCalls += 1;
      return clockCalls >= 4 ? new Date(NOW.getTime() + 60_000) : NOW;
    },
  });
  assert.deepEqual(github.writes, []);
  assert.equal(result.writeAttempted, false);
  assert.equal(result.status, "NOT_APPLIED");
});

test("프로세스가 provider write 직후 종료돼도 readback-first resume은 각 step을 중복 생성하지 않는다", async () => {
  for (const crashStep of ["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"] as const) {
    const github = new FakeGithub();
    const durableControlPlane = controlPlane({ crashBeforeCompletionStep: crashStep });
    const execute = () => executeGithubReadyPr({
      operationId: `operation:crash:${crashStep}`,
      workerPrincipalId: "codex:seorilabs-generic-worker",
      workerRuntimeBindingDigest: "d".repeat(64),
      rawCommand: command(),
      github,
      controlPlane: durableControlPlane,
      clock: () => NOW,
    });
    await assert.rejects(execute, /SIMULATED_PROCESS_CRASH/u);
    const resumed = await execute();
    assert.equal(resumed.status, "VERIFIED");
    assert.deepEqual(github.writes, ["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"]);
  }
});

test("만료 뒤 recovery adapter는 서버 ledger만 읽고 GitHub write 없이 부분 적용을 RESULT_UNKNOWN으로 남긴다", async () => {
  const github = new FakeGithub();
  const expectedCommitSha = deterministicGithubCommitSha({
    treeSha: TREE_SHA,
    parentSha: SOURCE_SHA,
    message: command().commitMessage,
    date: NOW,
  });
  github.commit = { sha: expectedCommitSha, treeSha: TREE_SHA, parentSha: SOURCE_SHA };
  const claimedKinds: string[] = [];
  const completedKinds: string[] = [];
  const cp = controlPlane({ readbackStatus: "RESULT_UNKNOWN" });
  cp.claimStep = async ({ body }) => {
    claimedKinds.push(body.stepKind);
    const verified = body.stepKind === "CREATE_COMMIT";
    return {
      executionId: body.executionId,
      stepId: `step:${body.stepKind}`,
      stepKind: body.stepKind,
      stepStatus: verified ? "VERIFIED" : "CLAIMED",
      generation: 2,
      attemptId: verified ? null : `attempt:${body.stepKind}`,
      expiresAt: verified ? null : new Date(NOW.getTime() + 60_000),
      expectedTreeSha: TREE_SHA,
      expectedCommitSha,
      expectedHeadRef: "refs/heads/seori/run-fixture-1",
      expectedPullRequestMarker: "seori-run:fixture:1",
      sourceSha: SOURCE_SHA,
      commitDate: NOW,
      writeDisposition: verified ? "ALREADY_VERIFIED" : "READBACK_ONLY",
      duplicate: false,
    };
  };
  cp.completeStep = async ({ body }) => {
    completedKinds.push(body.stepKind);
    return {
      executionId: body.executionId,
      stepId: body.stepId,
      attemptId: body.attemptId,
      generation: body.generation,
      status: "NOT_APPLIED",
      duplicate: false,
    };
  };
  const result = await recoverGithubReadyPr({
    operationId: "operation:expired-recovery",
    sessionId: "agent-session:readback",
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: "d".repeat(64),
    recovery: {
      executionId: "mutation-execution:fixture",
      status: "RESULT_UNKNOWN",
      repoId: "123",
      repoFullName: REPO,
      issueNumber: 7,
      sourceSha: SOURCE_SHA,
      expectedHeadRef: "refs/heads/seori/run-fixture-1",
      expectedPullRequestMarker: "seori-run:fixture:1",
      duplicate: false,
    },
    github,
    controlPlane: cp,
    clock: () => NOW,
  });
  assert.deepEqual(claimedKinds, ["CREATE_COMMIT", "CREATE_REF"]);
  assert.deepEqual(completedKinds, ["CREATE_REF"]);
  assert.deepEqual(github.writes, []);
  assert.deepEqual(result, {
    executionId: "mutation-execution:fixture",
    status: "RESULT_UNKNOWN",
    writeAttempted: false,
    safeToResume: true,
  });
});

test("recovery의 ALREADY_VERIFIED claim도 서버가 선택한 execution과 exact target에 결합한다", async () => {
  const github = new FakeGithub();
  const cp = controlPlane({ readbackStatus: "RESULT_UNKNOWN" });
  cp.claimStep = async ({ body }) => ({
    executionId: "mutation-execution:other",
    stepId: `step:${body.stepKind}`,
    stepKind: body.stepKind,
    stepStatus: "VERIFIED",
    generation: 1,
    attemptId: null,
    expiresAt: null,
    expectedTreeSha: TREE_SHA,
    expectedCommitSha: "c".repeat(40),
    expectedHeadRef: "refs/heads/seori/run-fixture-1",
    expectedPullRequestMarker: "seori-run:fixture:1",
    sourceSha: SOURCE_SHA,
    commitDate: NOW,
    writeDisposition: "ALREADY_VERIFIED",
    duplicate: false,
  });
  await assert.rejects(() => recoverGithubReadyPr({
    operationId: "operation:recovery-mismatched-verified",
    sessionId: "agent-session:readback",
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: "d".repeat(64),
    recovery: {
      executionId: "mutation-execution:fixture",
      status: "RESULT_UNKNOWN",
      repoId: "123",
      repoFullName: REPO,
      issueNumber: 7,
      sourceSha: SOURCE_SHA,
      expectedHeadRef: "refs/heads/seori/run-fixture-1",
      expectedPullRequestMarker: "seori-run:fixture:1",
      duplicate: false,
    },
    github,
    controlPlane: cp,
    clock: () => NOW,
  }), /GITHUB_READY_PR_RECOVERY_CLAIM_BINDING_MISMATCH/u);
  assert.deepEqual(github.writes, []);
});

test("terminal 또는 stale claim 충돌은 새 idempotency key로 다음 generation을 요청한다", async () => {
  const github = new FakeGithub();
  const claimRequestIds: string[] = [];
  const result = await executeGithubReadyPr({
    operationId: "operation:stale-claim-resume",
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: "d".repeat(64),
    rawCommand: command(),
    github,
    controlPlane: controlPlane({
      claimConflictOnceStep: "CREATE_COMMIT",
      onClaimRequest: (requestId) => claimRequestIds.push(requestId),
    }),
    clock: () => NOW,
  });
  assert.equal(result.status, "VERIFIED");
  assert.deepEqual(github.writes, ["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"]);
  assert.equal(claimRequestIds.length, 4);
  assert.notEqual(claimRequestIds[0], claimRequestIds[1]);
  assert.ok(claimRequestIds.every((requestId) => /^ghm:[0-9a-f]{64}$/u.test(requestId)));
});

test("deterministic commit SHA는 Git commit object hash와 일치한다", () => {
  const timestamp = Math.floor(NOW.getTime() / 1_000);
  const identity = `Seorilabs Automation <automation@seorilabs.com> ${timestamp} +0000`;
  const body = [
    `tree ${TREE_SHA}`,
    `parent ${SOURCE_SHA}`,
    `author ${identity}`,
    `committer ${identity}`,
    "",
    command().commitMessage,
  ].join("\n");
  const gitSha = execFileSync("git", ["hash-object", "-t", "commit", "--stdin"], {
    input: body,
    encoding: "utf8",
  }).trim();
  assert.equal(deterministicGithubCommitSha({
    treeSha: TREE_SHA,
    parentSha: SOURCE_SHA,
    message: command().commitMessage,
    date: NOW,
  }), gitSha);
});

test("cross-repo marker PR과 marker 없는 seori branch PR도 singleton blocker로 관측한다", async () => {
  const github = new FakeGithub();
  github.pulls = [{
    ...manualPullRequest(1),
    headRef: "refs/heads/seori/run-cross-repo",
    headRepoFullName: "someone/fork",
    body: "<!-- seori-run:forged:1 -->",
  }];
  const observation = await observeGithubReadyPr({ github, repoFullName: REPO, issueNumber: 7, now: NOW });
  assert.equal(observation.openAutopilotPullRequests.length, 1);
  assert.equal(observation.openAutopilotPullRequests[0].marker, "unmanaged-seori-pr:1");
});

test("OPEN과 mutation target pagination을 서로의 pageCount에 합산하지 않는다", async () => {
  const github = new FakeGithub();
  const observation = await observeGithubReadyPr({
    github,
    repoFullName: REPO,
    issueNumber: 7,
    expectedTarget: {
      headRef: "refs/heads/seori/run-fixture-1",
      marker: "seori-run:fixture:1",
    },
    now: NOW,
  });
  assert.equal(observation.pageCount, 2);
  assert.equal(observation.mutationTarget?.pageCount, 2);
});

test("단일 페이지 ALL snapshot은 불필요한 두 번째 순회를 하지 않는다", async () => {
  const github = new FakeGithub();
  github.pulls = [];
  await observeGithubReadyPr({ github, repoFullName: REPO, issueNumber: 7, now: NOW });
  assert.deepEqual(github.pageRequests, [{ state: "ALL", page: 1 }]);
});

test("pagination 중 PR 상태가 바뀌면 complete snapshot으로 확정하지 않는다", async () => {
  const github = new FakeGithub();
  github.closeFirstAfterPageOne = true;
  github.pulls.push({
    ...manualPullRequest(999),
    headRef: "refs/heads/seori/run-fixture-1",
    body: "<!-- seori-run:fixture:1 -->",
  });
  await assert.rejects(() => observeGithubReadyPr({
    github,
    repoFullName: REPO,
    issueNumber: 7,
    expectedTarget: {
      headRef: "refs/heads/seori/run-fixture-1",
      marker: "seori-run:fixture:1",
    },
    now: NOW,
  }), /GITHUB_READY_PR_UNSTABLE_SNAPSHOT/);
  assert.equal(github.pageRequests.some((request) => request.state === "OPEN"), false);
});

test("변경 payload는 workflow, secret 경로, credential 내용, reserved PR directive를 거부한다", () => {
  assert.throws(() => prepareGithubReadyPrCommand({
    ...command(),
    files: [{ path: ".github/workflows/release.yml", contentBase64: Buffer.from("name: release\n").toString("base64") }],
  }));
  assert.throws(() => prepareGithubReadyPrCommand({
    ...command(),
    files: [{ path: "src/key.ts", contentBase64: Buffer.from("const password = 'hunter2000';\n").toString("base64") }],
  }));
  assert.throws(() => prepareGithubReadyPrCommand({ ...command(), body: "Closes #7" }));
  assert.throws(() => prepareGithubReadyPrCommand({ ...command(), body: "Closes #7\n\nFixes #8" }));
  assert.throws(() => prepareGithubReadyPrCommand({ ...command(), body: "Fixes: seorilabs/other#8" }));
  assert.throws(() => prepareGithubReadyPrCommand({
    ...command(),
    body: "Resolves https://github.com/seorilabs/other/issues/8",
  }));
  assert.throws(() => prepareGithubReadyPrCommand({
    ...command(),
    commitMessage: "fix: 중앙 계약 적용\n\nCloses: seorilabs/other#8",
  }));
  for (const candidate of [
    ["xoxb", "1234567890", "abcdefghijklmnop"].join("-"),
    ["AK", "IAIOSFODNN7EXAMPLE"].join(""),
    ["AI", "zaSyA123456789012345678901234567890"].join(""),
    ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "signature123"].join("."),
  ]) {
    assert.throws(() => prepareGithubReadyPrCommand({
      ...command(),
      files: [{
        path: "src/key.ts",
        contentBase64: Buffer.from(candidate).toString("base64"),
      }],
    }));
  }
});
