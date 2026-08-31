import { createHash } from "node:crypto";
import type { Octokit } from "octokit";

import { computeFleetEvidenceDigest } from "@seorilabs/repo-contract/fleet-migration";
import { createTrustedFleetCleanupGitHubAdapter } from "@seorilabs/repo-contract/trusted-cleanup-executor";

import {
  deterministicGithubCommitSha,
  GITHUB_AUTOMATION_COMMIT_IDENTITY,
} from "@/lib/control-plane/github-ready-pr-adapter";
import {
  readFleetCleanupCapability,
  recordFleetCleanupCommitPlan,
  type FleetCleanupStateClient,
} from "@/lib/control-plane/fleet-cleanup-authority";
import type {
  FleetCleanupFileAction,
  FleetCleanupReplacementFile,
} from "@/lib/control-plane/fleet-cleanup-capability-contract";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { withFleetScopedGithubClient } from "@/lib/github/scoped-installation-client";

const SHA = /^[0-9a-f]{40}$/u;
const PER_PAGE = 100;
const MAX_PAGES = 1_000;

function fail(code: string): never {
  throw new Error(code);
}

function splitRepository(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo || owner !== "seorilabs") fail("FLEET_CLEANUP_GITHUB_REPOSITORY_INVALID");
  return { owner, repo };
}

function evidence<T extends Record<string, unknown>>(value: T): T & { evidenceDigest: string } {
  const result = { ...value, evidenceDigest: `sha256:${"0".repeat(64)}` };
  result.evidenceDigest = computeFleetEvidenceDigest(result);
  return result;
}

function sha256(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitBlobSha(value: Buffer): string {
  return createHash("sha1")
    .update(`blob ${value.length}\0`, "utf8")
    .update(value)
    .digest("hex");
}

function absent(kind: string, request: Record<string, unknown>, now: Date, state = "ABSENT") {
  return evidence({
    contract: "seorilabs-fleet-cleanup-mutation-readback-v1",
    kind,
    state,
    readbackId: `fleet-cleanup-${kind.toLowerCase()}-absent-${now.getTime()}`,
    observedAt: now.toISOString(),
    repositoryId: request.repositoryId,
    fullName: request.fullName,
    operationId: request.operationId,
  });
}

async function allPullRequests(client: Octokit, fullName: string, state: "open" | "all") {
  const binding = splitRepository(fullName);
  const pulls: Array<{
    number: number;
    state: string;
    draft: boolean;
    baseRef: string;
    headRef: string;
    headSha: string;
    title: string;
    body: string;
    url: string;
  }> = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await client.rest.pulls.list({
      ...binding,
      state,
      sort: "created",
      direction: "asc",
      page,
      per_page: PER_PAGE,
    });
    pulls.push(...response.data.map((pull) => ({
      number: pull.number,
      state: pull.state,
      draft: pull.draft ?? false,
      baseRef: pull.base.ref,
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      title: pull.title,
      body: pull.body ?? "",
      url: pull.html_url,
    })));
    if (response.data.length < PER_PAGE) return pulls;
  }
  fail("FLEET_CLEANUP_GITHUB_PAGINATION_LIMIT");
}

function actionSet(row: Awaited<ReturnType<typeof readFleetCleanupCapability>>): FleetCleanupFileAction[] {
  return row.fileActionSet as unknown as FleetCleanupFileAction[];
}

function replacementSet(row: Awaited<ReturnType<typeof readFleetCleanupCapability>>): FleetCleanupReplacementFile[] {
  return row.replacementFiles as unknown as FleetCleanupReplacementFile[];
}

interface CleanupMutation extends Record<string, unknown> {
  operation: "DELETE" | "REWRITE";
  path: string;
  expectedMode: "100644" | "100755";
  expectedBlobSha: string;
  expectedContentDigest: string;
  replacementDigest: string;
  replacementBindingDigest: string;
  content: Buffer | null;
}

interface CleanupGithubRequest extends Record<string, unknown> {
  repositoryId: string;
  fullName: string;
  operationId: string;
  sourceSha: string;
  treeSha: string;
  defaultRef: string;
  issueNumber: number;
  approvalScopeDigest: string;
  expectedHeadRef: string;
  expectedPullRequestOperationId: string;
  expectedBlobs: Array<{ path: string; mode: string; objectSha: string; contentDigest: string }>;
  path: string;
  planDigest: string;
  replacementDigest: string;
  replacementBindingDigest: string;
  parentSha: string;
  sourceTreeSha: string;
  mutationsDigest: string;
  message: string;
  mutations: CleanupMutation[];
  ref: string;
  commitSha: string;
  expectedAbsent: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  title: string;
  body: string;
  bodyDigest: string;
  draft: boolean;
  expectedOpenAutonomousReadyPullRequestCount: number;
}

function exactMutations(input: {
  request: CleanupGithubRequest;
  actions: FleetCleanupFileAction[];
  replacements: FleetCleanupReplacementFile[];
}) {
  const mutations = input.request.mutations;
  if (!Array.isArray(mutations) || mutations.length !== input.actions.length) {
    fail("FLEET_CLEANUP_GITHUB_MUTATION_SET_MISMATCH");
  }
  const replacementByPath = new Map(input.replacements.map((file) => [file.path, file]));
  const descriptors = input.actions.map((action, index) => {
    const mutation = mutations[index];
    const replacement = replacementByPath.get(action.path);
    const content = Buffer.isBuffer(mutation.content) ? mutation.content : null;
    if (
      mutation.operation !== action.operation
      || mutation.path !== action.path
      || mutation.expectedMode !== action.expectedMode
      || mutation.expectedBlobSha !== action.expectedBlobSha
      || mutation.expectedContentDigest !== action.expectedContentDigest
      || mutation.replacementDigest !== action.replacementDigest
      || mutation.replacementBindingDigest !== action.replacementBindingDigest
      || (action.operation === "DELETE" && mutation.content !== null)
      || (action.operation === "REWRITE" && (
        !content
        || !replacement
        || sha256(content) !== replacement.contentDigest
      ))
    ) fail("FLEET_CLEANUP_GITHUB_MUTATION_SET_MISMATCH");
    return {
      operation: action.operation,
      path: action.path,
      expectedMode: action.expectedMode,
      expectedBlobSha: action.expectedBlobSha,
      expectedContentDigest: action.expectedContentDigest,
      replacementDigest: action.replacementDigest,
      replacementBindingDigest: action.replacementBindingDigest,
      resultBlobSha: action.operation === "DELETE" ? null : gitBlobSha(content!),
    };
  });
  return { mutations, descriptors };
}

export function createFleetCleanupGithubProvider(input: {
  capabilityId: string;
  client: Octokit;
  stateClient?: FleetCleanupStateClient;
  now?: () => Date;
}) {
  const now = () => input.now?.() ?? new Date();
  const provider = {
    async readMutationGuard(request: CleanupGithubRequest) {
      const observedAt = now();
      const capability = await readFleetCleanupCapability({ capabilityId: input.capabilityId, client: input.stateClient });
      const authority = capability.authority;
      if (
        !["ACTIVE", "COMPLETED"].includes(capability.state)
        || capability.expiresAt <= observedAt
        || capability.approvalScopeDigest !== request.approvalScopeDigest
        || capability.issueNumber !== request.issueNumber
        || authority.repositoryId.toString() !== request.repositoryId
        || authority.repositoryFullName !== request.fullName
        || authority.sourceSha !== request.sourceSha
        || authority.treeSha !== request.treeSha
      ) fail("FLEET_CLEANUP_GITHUB_CAPABILITY_MISMATCH");
      const binding = splitRepository(request.fullName);
      const [repository, branch, issue, pulls, tree] = await Promise.all([
        input.client.rest.repos.get(binding),
        input.client.rest.repos.getBranch({
          ...binding,
          branch: String(request.defaultRef).replace(/^refs\/heads\//u, ""),
        }),
        input.client.rest.issues.get({ ...binding, issue_number: request.issueNumber }),
        allPullRequests(input.client, request.fullName, "open"),
        input.client.rest.git.getTree({ ...binding, tree_sha: request.treeSha, recursive: "true" }),
      ]);
      if ("pull_request" in issue.data || tree.data.truncated) {
        fail("FLEET_CLEANUP_GITHUB_GUARD_INCOMPLETE");
      }
      const entries = new Map(tree.data.tree.map((entry) => [entry.path, entry]));
      const blobs = await Promise.all(request.expectedBlobs.map(async (expected) => {
        const entry = entries.get(expected.path);
        if (
          entry?.type !== "blob"
          || entry.mode !== expected.mode
          || entry.sha !== expected.objectSha
        ) fail("FLEET_CLEANUP_GITHUB_BLOB_DRIFT");
        const blob = await input.client.rest.git.getBlob({ ...binding, file_sha: expected.objectSha });
        const bytes = Buffer.from(blob.data.content.replace(/\n/gu, ""), "base64");
        try {
          return {
            path: expected.path,
            mode: expected.mode,
            objectSha: expected.objectSha,
            contentDigest: sha256(bytes),
          };
        } finally {
          bytes.fill(0);
        }
      }));
      const readyPullRequests = pulls.filter((pull) => !pull.draft);
      const labels = issue.data.labels
        .map((label) => typeof label === "string" ? label : label.name)
        .filter((label): label is string => Boolean(label))
        .map((label) => label.toLowerCase())
        .sort();
      return evidence({
        contract: "seorilabs-fleet-cleanup-mutation-guard-v1",
        readbackId: `fleet-cleanup-guard-${observedAt.getTime()}`,
        observedAt: observedAt.toISOString(),
        organizationId: authority.organizationId,
        installationId: authority.installationId,
        repositoryId: String(repository.data.id),
        fullName: repository.data.full_name,
        defaultRef: `refs/heads/${repository.data.default_branch}`,
        defaultHeadSha: branch.data.commit.sha,
        treeSha: request.treeSha,
        archived: repository.data.archived,
        fork: repository.data.fork,
        openAutonomousReadyPullRequestCount: readyPullRequests.length,
        openAutonomousReadyPullRequests: readyPullRequests.map((pull) => ({
          number: pull.number,
          state: "OPEN",
          isDraft: false,
          baseRef: pull.baseRef,
          headRef: pull.headRef,
          headSha: pull.headSha,
          operationId: pull.headRef === request.expectedHeadRef
            ? request.expectedPullRequestOperationId
            : `foreign-ready-pr-${pull.number}`,
        })),
        issue: {
          number: issue.data.number,
          state: issue.data.state === "open" ? "OPEN" : "CLOSED",
          labels,
          approvalState: "APPROVED",
          approvalId: capability.id,
          approvalScopeDigest: capability.approvalScopeDigest,
          approvedAt: capability.approvedAt.toISOString(),
          expiresAt: capability.expiresAt.toISOString(),
        },
        blobs,
      });
    },

    async readReplacementBlob(request: CleanupGithubRequest) {
      const capability = await readFleetCleanupCapability({ capabilityId: input.capabilityId, client: input.stateClient });
      const replacement = replacementSet(capability).find((candidate) => candidate.path === request.path);
      const action = actionSet(capability).find((candidate) => candidate.path === request.path);
      if (
        !replacement
        || action?.operation !== "REWRITE"
        || replacement.contentDigest !== request.replacementDigest
        || action.replacementBindingDigest !== request.replacementBindingDigest
        || capability.authority.planDigest !== request.planDigest
      ) fail("FLEET_CLEANUP_REPLACEMENT_BINDING_MISMATCH");
      return {
        contract: "seorilabs-fleet-cleanup-replacement-readback-v1",
        readbackId: `fleet-cleanup-replacement-${jsonDigest(request.path).slice(0, 24)}`,
        observedAt: now().toISOString(),
        repositoryId: request.repositoryId,
        fullName: request.fullName,
        sourceSha: request.sourceSha,
        path: request.path,
        planDigest: request.planDigest,
        replacementDigest: request.replacementDigest,
        replacementBindingDigest: request.replacementBindingDigest,
        content: Buffer.from(replacement.contentBase64, "base64"),
      };
    },

    async readCommit(request: CleanupGithubRequest) {
      const capability = await readFleetCleanupCapability({ capabilityId: input.capabilityId, client: input.stateClient });
      const execution = capability.execution;
      if (!execution?.expectedCommitSha) return absent("CREATE_COMMIT", request, now());
      if (
        execution.mutationsDigest !== request.mutationsDigest
        || execution.sourceSha !== request.parentSha
        || capability.authority.treeSha !== request.sourceTreeSha
      ) fail("FLEET_CLEANUP_COMMIT_PLAN_MISMATCH");
      try {
        const commit = await input.client.rest.git.getCommit({
          ...splitRepository(request.fullName),
          commit_sha: execution.expectedCommitSha,
        });
        if (commit.data.parents.length !== 1) fail("FLEET_CLEANUP_COMMIT_PARENT_MISMATCH");
        return evidence({
          contract: "seorilabs-fleet-cleanup-mutation-readback-v1",
          kind: "CREATE_COMMIT",
          state: "FOUND",
          readbackId: `fleet-cleanup-commit-${now().getTime()}`,
          observedAt: now().toISOString(),
          repositoryId: request.repositoryId,
          fullName: request.fullName,
          operationId: request.operationId,
          parentSha: commit.data.parents[0].sha,
          sourceTreeSha: capability.authority.treeSha,
          commitSha: commit.data.sha,
          treeSha: commit.data.tree.sha,
          mutationsDigest: execution.mutationsDigest,
          changes: execution.mutationSet,
        });
      } catch (error) {
        if (typeof error === "object" && error && "status" in error && error.status === 404) {
          return absent("CREATE_COMMIT", request, now());
        }
        throw error;
      }
    },

    async createCommit(request: CleanupGithubRequest) {
      const capability = await readFleetCleanupCapability({ capabilityId: input.capabilityId, client: input.stateClient });
      const { mutations, descriptors } = exactMutations({
        request,
        actions: actionSet(capability),
        replacements: replacementSet(capability),
      });
      const binding = splitRepository(request.fullName);
      const tree = await input.client.rest.git.createTree({
        ...binding,
        base_tree: request.sourceTreeSha,
        tree: mutations.map((mutation) => mutation.operation === "DELETE"
          ? {
              path: mutation.path,
              mode: mutation.expectedMode,
              type: "blob" as const,
              sha: null,
            }
          : {
              path: mutation.path,
              mode: mutation.expectedMode,
              type: "blob" as const,
              content: (mutation.content as Buffer).toString("utf8"),
            }),
      });
      if (tree.data.sha === request.sourceTreeSha) fail("FLEET_CLEANUP_GITHUB_NO_CHANGES");
      const commitDate = new Date(Math.floor(capability.approvedAt.getTime() / 1_000) * 1_000);
      const expectedCommitSha = deterministicGithubCommitSha({
        treeSha: tree.data.sha,
        parentSha: request.parentSha,
        message: request.message,
        date: commitDate,
      });
      await recordFleetCleanupCommitPlan({
        capabilityId: input.capabilityId,
        operationId: request.operationId,
        mutationsDigest: request.mutationsDigest,
        mutationSet: descriptors as unknown as JsonValue,
        commitDate,
        expectedTreeSha: tree.data.sha,
        expectedCommitSha,
        client: input.stateClient,
      });
      const identity = {
        ...GITHUB_AUTOMATION_COMMIT_IDENTITY,
        date: commitDate.toISOString(),
      };
      const commit = await input.client.rest.git.createCommit({
        ...binding,
        message: request.message,
        tree: tree.data.sha,
        parents: [request.parentSha],
        author: identity,
        committer: identity,
      });
      if (commit.data.sha !== expectedCommitSha) fail("FLEET_CLEANUP_COMMIT_SHA_MISMATCH");
    },

    async readRef(request: CleanupGithubRequest) {
      try {
        const ref = await input.client.rest.git.getRef({
          ...splitRepository(request.fullName),
          ref: String(request.ref).replace(/^refs\//u, ""),
        });
        return evidence({
          contract: "seorilabs-fleet-cleanup-mutation-readback-v1",
          kind: "CREATE_REF",
          state: "FOUND",
          readbackId: `fleet-cleanup-ref-${now().getTime()}`,
          observedAt: now().toISOString(),
          repositoryId: request.repositoryId,
          fullName: request.fullName,
          operationId: request.operationId,
          ref: request.ref,
          commitSha: ref.data.object.sha,
        });
      } catch (error) {
        if (typeof error === "object" && error && "status" in error && error.status === 404) {
          return absent("CREATE_REF", request, now());
        }
        throw error;
      }
    },

    async createRef(request: CleanupGithubRequest) {
      if (request.expectedAbsent !== true || !SHA.test(request.commitSha)) {
        fail("FLEET_CLEANUP_REF_REQUEST_INVALID");
      }
      await input.client.rest.git.createRef({
        ...splitRepository(request.fullName),
        ref: request.ref,
        sha: request.commitSha,
      });
    },

    async readPullRequest(request: CleanupGithubRequest) {
      const pulls = await allPullRequests(input.client, request.fullName, "all");
      const matches = pulls.filter((pull) => (
        pull.headRef === request.headRef
        && pull.baseRef === request.baseRef
      ));
      if (matches.length === 0) return absent("CREATE_PR", request, now());
      if (matches.length !== 1) fail("FLEET_CLEANUP_PR_READBACK_AMBIGUOUS");
      const pull = matches[0];
      return evidence({
        contract: "seorilabs-fleet-cleanup-mutation-readback-v1",
        kind: "CREATE_PR",
        readbackId: `fleet-cleanup-pr-${now().getTime()}`,
        observedAt: now().toISOString(),
        repositoryId: request.repositoryId,
        fullName: request.fullName,
        operationId: request.operationId,
        number: pull.number,
        url: pull.url,
        state: pull.state === "open" ? "OPEN" : "CLOSED",
        isDraft: pull.draft,
        baseRef: pull.baseRef,
        headRef: pull.headRef,
        headSha: pull.headSha,
        title: pull.title,
        bodyDigest: sha256(pull.body),
      });
    },

    async createPullRequest(request: CleanupGithubRequest) {
      if (
        request.draft !== false
        || request.expectedOpenAutonomousReadyPullRequestCount !== 0
        || sha256(request.body) !== request.bodyDigest
      ) fail("FLEET_CLEANUP_PR_REQUEST_INVALID");
      const binding = splitRepository(request.fullName);
      const [repository, ref, pulls] = await Promise.all([
        input.client.rest.repos.get(binding),
        input.client.rest.git.getRef({ ...binding, ref: `heads/${request.headRef}` }),
        allPullRequests(input.client, request.fullName, "open"),
      ]);
      if (
        repository.data.default_branch !== request.baseRef
        || ref.data.object.sha !== request.headSha
        || pulls.some((pull) => !pull.draft)
      ) fail("FLEET_CLEANUP_PR_DISPATCH_GUARD_MISMATCH");
      await input.client.rest.pulls.create({
        ...binding,
        title: request.title,
        body: request.body,
        head: request.headRef,
        base: request.baseRef,
        draft: false,
      });
    },
  };
  return Object.freeze({
    provider,
    adapter: createTrustedFleetCleanupGitHubAdapter({ provider }),
  });
}

export async function withFleetCleanupGithub<Result>(input: {
  capabilityId: string;
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  execute: (adapter: ReturnType<typeof createFleetCleanupGithubProvider>["adapter"]) => Promise<Result>;
}) {
  const { getFleetScopedGithubTokenIssuer } = await import("@/lib/github/app");
  const scoped = await getFleetScopedGithubTokenIssuer();
  if (scoped.installationId !== input.installationId) {
    fail("FLEET_CLEANUP_GITHUB_INSTALLATION_MISMATCH");
  }
  return withFleetScopedGithubClient({
    issuer: scoped.issuer,
    installationId: input.installationId,
    capability: "github.fleet-cleanup.ready-pr",
    repositoryId: input.repositoryId,
    repositoryFullName: input.repositoryFullName,
    execute: (client) => input.execute(createFleetCleanupGithubProvider({
      capabilityId: input.capabilityId,
      client,
    }).adapter),
  });
}
