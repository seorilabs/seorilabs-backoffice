import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { Octokit } from "octokit";

import { deterministicGithubCommitSha } from "@/lib/control-plane/github-ready-pr-adapter";
import { createFleetCleanupGithubProvider } from "@/lib/control-plane/fleet-cleanup-github-provider";
import type { FleetCleanupStateClient } from "@/lib/control-plane/fleet-cleanup-authority";

const NOW = new Date("2026-08-31T01:00:00.000Z");
const SOURCE_SHA = "a".repeat(40);
const SOURCE_TREE_SHA = "b".repeat(40);
const SOURCE_BLOB_SHA = "c".repeat(40);
const RESULT_TREE_SHA = "d".repeat(40);
const OPERATION_ID = `sha256:${"1".repeat(64)}`;
const APPROVAL_DIGEST = `sha256:${"2".repeat(64)}`;
const MUTATIONS_DIGEST = `sha256:${"3".repeat(64)}`;
const CONTENT = Buffer.from("legacy tag authority\n", "utf8");

function sha256(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture() {
  const action = {
    operation: "DELETE",
    path: ".seorilabs/tag-authority.json",
    expectedMode: "100644",
    expectedBlobSha: SOURCE_BLOB_SHA,
    expectedContentDigest: sha256(CONTENT),
    replacementDigest: `sha256:${"4".repeat(64)}`,
    replacementBindingDigest: `sha256:${"5".repeat(64)}`,
    idempotencyKey: `sha256:${"6".repeat(64)}`,
  };
  const execution = {
    id: "fleet-cleanup-execution-0001",
    authorityId: "fleet-cleanup-authority-0001",
    capabilityId: "fleet-cleanup-capability-0001",
    sourceSha: SOURCE_SHA,
    mutationsDigest: null as string | null,
    mutationSet: null as unknown,
    commitDate: null as Date | null,
    expectedTreeSha: null as string | null,
    expectedCommitSha: null as string | null,
    steps: [{ kind: "CREATE_COMMIT", operationId: OPERATION_ID }],
  };
  const capability = {
    id: "fleet-cleanup-capability-0001",
    state: "ACTIVE",
    action: "READY_PR_ONLY",
    expiresAt: new Date(NOW.getTime() + 15 * 60_000),
    approvedAt: NOW,
    approvalScopeDigest: APPROVAL_DIGEST,
    issueNumber: 7001,
    issuance: {},
    plan: {},
    fileActionSet: [action],
    replacementFiles: [],
    authority: {
      organizationId: "283115031",
      installationId: "142120077",
      repositoryId: 1250442131n,
      repositoryFullName: "seorilabs/happy-farm",
      sourceSha: SOURCE_SHA,
      treeSha: SOURCE_TREE_SHA,
      planDigest: `sha256:${"7".repeat(64)}`,
    },
    execution,
  };
  const stateClient = {
    fleetCleanupCapability: {
      async findUnique() { return capability; },
    },
    fleetCleanupExecution: {
      async updateMany(input: { data: Record<string, unknown> }) {
        Object.assign(execution, input.data);
        return { count: 1 };
      },
    },
  } as unknown as FleetCleanupStateClient;

  const refs = new Map<string, string>();
  const commits = new Map<string, { sha: string; treeSha: string; parentSha: string }>();
  const pulls: Array<{
    number: number;
    state: string;
    draft: boolean;
    baseRef: string;
    headRef: string;
    headSha: string;
    title: string;
    body: string;
  }> = [];
  const calls = { createTree: 0, createCommit: 0, createRef: 0, createPullRequest: 0 };
  const client = {
    rest: {
      repos: {
        async get() {
          return { data: { id: 1250442131, full_name: "seorilabs/happy-farm", default_branch: "main", archived: false, fork: false } };
        },
        async getBranch() { return { data: { commit: { sha: SOURCE_SHA } } }; },
      },
      issues: {
        async get() { return { data: { number: 7001, state: "open", labels: [{ name: "autopilot" }] } }; },
      },
      pulls: {
        async list(input: { state: string }) {
          return { data: pulls.filter((pull) => input.state === "all" || pull.state === input.state).map((pull) => ({
            number: pull.number,
            state: pull.state,
            draft: pull.draft,
            base: { ref: pull.baseRef },
            head: { ref: pull.headRef, sha: pull.headSha },
            title: pull.title,
            body: pull.body,
            html_url: `https://github.com/seorilabs/happy-farm/pull/${pull.number}`,
          })) };
        },
        async create(input: { title: string; body: string; head: string; base: string; draft: boolean }) {
          calls.createPullRequest += 1;
          pulls.push({
            number: 81,
            state: "open",
            draft: input.draft,
            baseRef: input.base,
            headRef: input.head,
            headSha: refs.get(`refs/heads/${input.head}`)!,
            title: input.title,
            body: input.body,
          });
          return { data: { number: 81 } };
        },
      },
      git: {
        async getTree() {
          return { data: { truncated: false, tree: [{ path: action.path, type: "blob", mode: action.expectedMode, sha: action.expectedBlobSha }] } };
        },
        async getBlob() { return { data: { content: CONTENT.toString("base64") } }; },
        async createTree() {
          calls.createTree += 1;
          return { data: { sha: RESULT_TREE_SHA } };
        },
        async createCommit(input: { message: string; tree: string; parents: string[]; author: { date: string } }) {
          calls.createCommit += 1;
          const sha = deterministicGithubCommitSha({
            treeSha: input.tree,
            parentSha: input.parents[0],
            message: input.message,
            date: new Date(input.author.date),
          });
          commits.set(sha, { sha, treeSha: input.tree, parentSha: input.parents[0] });
          return { data: { sha } };
        },
        async getCommit(input: { commit_sha: string }) {
          const commit = commits.get(input.commit_sha);
          if (!commit) throw Object.assign(new Error("not found"), { status: 404 });
          return { data: { sha: commit.sha, tree: { sha: commit.treeSha }, parents: [{ sha: commit.parentSha }] } };
        },
        async getRef(input: { ref: string }) {
          const sha = refs.get(`refs/${input.ref}`);
          if (!sha) throw Object.assign(new Error("not found"), { status: 404 });
          return { data: { object: { sha } } };
        },
        async createRef(input: { ref: string; sha: string }) {
          calls.createRef += 1;
          refs.set(input.ref, input.sha);
          return { data: { ref: input.ref } };
        },
      },
    },
  } as unknown as Octokit;
  return { action, capability, execution, stateClient, client, calls };
}

test("GitHub mutation은 commit/ref/Ready PR을 만든 뒤 exact provider readback으로 확정한다", async () => {
  const current = fixture();
  const provider = createFleetCleanupGithubProvider({
    capabilityId: current.capability.id,
    client: current.client,
    stateClient: current.stateClient,
    now: () => NOW,
  }).provider;
  const common = {
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    operationId: OPERATION_ID,
    sourceSha: SOURCE_SHA,
    treeSha: SOURCE_TREE_SHA,
    defaultRef: "refs/heads/main",
    issueNumber: 7001,
    approvalScopeDigest: APPROVAL_DIGEST,
    expectedHeadRef: "seori/fleet-cleanup/7001",
    expectedPullRequestOperationId: `sha256:${"8".repeat(64)}`,
    expectedBlobs: [{ path: current.action.path, mode: current.action.expectedMode, objectSha: SOURCE_BLOB_SHA, contentDigest: current.action.expectedContentDigest }],
  };
  const guard = await provider.readMutationGuard(common as never);
  assert.equal(guard.repositoryId, "1250442131");
  assert.equal(guard.defaultHeadSha, SOURCE_SHA);
  assert.deepEqual(guard.issue.labels, ["autopilot"]);
  assert.equal(guard.openAutonomousReadyPullRequestCount, 0);

  const message = "P7 태그 정본을 중앙 계약으로 이관";
  const commitRequest = {
    ...common,
    parentSha: SOURCE_SHA,
    sourceTreeSha: SOURCE_TREE_SHA,
    mutationsDigest: MUTATIONS_DIGEST,
    message,
    mutations: [{ ...current.action, content: null }],
  };
  assert.equal((await provider.readCommit(commitRequest as never)).state, "ABSENT");
  await provider.createCommit(commitRequest as never);
  const commit = await provider.readCommit(commitRequest as never);
  const commitValue = commit as unknown as Record<string, unknown>;
  assert.equal(commit.state, "FOUND");
  assert.equal(commitValue.commitSha, current.execution.expectedCommitSha);
  assert.equal(commitValue.parentSha, SOURCE_SHA);
  assert.equal(commitValue.treeSha, RESULT_TREE_SHA);

  const ref = "refs/heads/seori/fleet-cleanup/7001";
  const refRequest = { ...common, ref, commitSha: commitValue.commitSha, expectedAbsent: true };
  assert.equal((await provider.readRef(refRequest as never)).state, "ABSENT");
  await provider.createRef(refRequest as never);
  const refReadback = await provider.readRef(refRequest as never);
  assert.equal(refReadback.state, "FOUND");
  assert.equal((refReadback as unknown as Record<string, unknown>).commitSha, commitValue.commitSha);

  const body = "Closes #7001\n";
  const pullRequest = {
    ...common,
    baseRef: "main",
    baseSha: SOURCE_SHA,
    headRef: "seori/fleet-cleanup/7001",
    headSha: commitValue.commitSha,
    title: "P7 태그 정본을 중앙 계약으로 이관",
    body,
    bodyDigest: sha256(body),
    draft: false,
    expectedOpenAutonomousReadyPullRequestCount: 0,
  };
  assert.equal((await provider.readPullRequest(pullRequest as never)).state, "ABSENT");
  await provider.createPullRequest(pullRequest as never);
  const pullReadback = await provider.readPullRequest(pullRequest as never);
  const pullValue = pullReadback as unknown as Record<string, unknown>;
  assert.equal(pullReadback.state, "OPEN");
  assert.equal(pullValue.isDraft, false);
  assert.equal(pullValue.baseRef, "main");
  assert.equal(pullValue.headRef, "seori/fleet-cleanup/7001");
  assert.equal(pullValue.headSha, commitValue.commitSha);
  assert.equal(pullValue.bodyDigest, sha256(body));
  assert.deepEqual(current.calls, { createTree: 1, createCommit: 1, createRef: 1, createPullRequest: 1 });
});
