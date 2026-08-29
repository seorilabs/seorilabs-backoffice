import assert from "node:assert/strict";
import { test } from "node:test";

import {
  executeGithubReadyPr,
  observeGithubReadyPr,
  prepareGithubReadyPrCommand,
  type GithubMutationControlPlane,
  type GithubPullRequestState,
  type GithubReadyPrPort,
} from "@/lib/control-plane/github-ready-pr-adapter";

const SOURCE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
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
  applyCount = 0;
  repositoryReads = 0;
  defaultBranchSha = SOURCE_SHA;
  driftOnSecondRepositoryRead = false;
  pulls: GithubPullRequestState[] = Array.from({ length: 100 }, (_, index) => manualPullRequest(index + 100));

  async getRepository() {
    this.repositoryReads += 1;
    if (this.driftOnSecondRepositoryRead && this.repositoryReads >= 2) this.defaultBranchSha = "c".repeat(40);
    return { id: 123, fullName: REPO, defaultBranch: "main", defaultBranchSha: this.defaultBranchSha };
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
    return visible.slice((input.page - 1) * input.perPage, input.page * input.perPage);
  }

  async getRef(_repoFullName: string, ref: string) {
    const pullRequest = this.pulls.find((candidate) => candidate.headRef === ref);
    return pullRequest ? { sha: pullRequest.headSha } : null;
  }

  async applyReadyPr(input: {
    expectedHeadRef: string;
    expectedMarker: string;
    issueNumber: number | null;
    title: string;
  }) {
    this.applyCount += 1;
    this.pulls.push({
      number: 7,
      nodeId: "PR_fixture_7",
      url: `https://github.com/${REPO}/pull/7`,
      state: "OPEN",
      draft: false,
      headRef: input.expectedHeadRef,
      headRepoFullName: REPO,
      headSha: HEAD_SHA,
      baseRef: "refs/heads/main",
      baseRepoFullName: REPO,
      baseSha: SOURCE_SHA,
      body: `${input.title}\n\nCloses #${input.issueNumber}\n\n<!-- ${input.expectedMarker} -->`,
    });
  }
}

function controlPlane(input: {
  duplicate?: boolean;
  readbackStatus?: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN";
  onAuthorize?: (body: Record<string, unknown>) => void;
} = {}): GithubMutationControlPlane {
  return {
    authorize: async ({ body }) => {
      input.onAuthorize?.(body as unknown as Record<string, unknown>);
      return {
        executionId: "mutation-execution:fixture",
        action: "GITHUB_READY_PR_MUTATE",
        mutationIntentDigest: body.mutationIntentDigest,
        expectedHeadRef: "refs/heads/seori/run-fixture-1",
        expectedPullRequestMarker: "seori-run:fixture:1",
        expiresAt: new Date(NOW.getTime() + 60_000),
        status: "CONSUMED",
        writeDisposition: input.duplicate ? "READBACK_ONLY" : "EXECUTE_ONCE",
        duplicate: input.duplicate ?? false,
      };
    },
    readback: async ({ body }) => ({
      executionId: body.executionId,
      status: input.readbackStatus ?? "VERIFIED",
      duplicate: false,
    }),
  };
}

test("shadow adapter는 complete pagination 뒤 JIT authorize, 비활성 composite attempt, fresh signed readback 순서를 검증한다", async () => {
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
  assert.equal(github.applyCount, 1);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(result.pullRequestUrl, `https://github.com/${REPO}/pull/7`);
  assert.ok(github.pageRequests.some((request) => request.state === "OPEN" && request.page === 2));
  assert.ok(github.pageRequests.some((request) => request.state === "ALL" && request.page === 2));
});

test("동일 idempotency authorization의 READBACK_ONLY는 GitHub write를 반복하지 않는다", async () => {
  const github = new FakeGithub();
  github.pulls.push({
    ...manualPullRequest(7),
    nodeId: "PR_fixture_7",
    headRef: "refs/heads/seori/run-fixture-1",
    headSha: HEAD_SHA,
    body: "Closes #7\n\n<!-- seori-run:fixture:1 -->",
  });
  const result = await executeGithubReadyPr({
    operationId: "operation:fixture-duplicate",
    workerPrincipalId: "claude:seorilabs-generic-worker",
    workerRuntimeBindingDigest: "e".repeat(64),
    rawCommand: command(),
    github,
    controlPlane: controlPlane({ duplicate: true }),
    clock: () => NOW,
  });
  assert.equal(github.applyCount, 0);
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
  assert.equal(github.applyCount, 0);
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
  assert.equal(github.applyCount, 0);
  assert.equal(result.writeAttempted, false);
  assert.equal(result.status, "NOT_APPLIED");
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
});
