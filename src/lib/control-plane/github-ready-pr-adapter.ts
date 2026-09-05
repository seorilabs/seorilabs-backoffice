import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { z } from "zod";

import {
  agentGithubMutationStepObservationSchema,
  agentGithubObservationSchema,
  containsCredentialCandidate,
  type AgentGithubMutationStepKind,
  type AgentGithubMutationStepObservation,
  type AgentGithubObservation,
} from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import type { WorkerPrincipal } from "@/lib/control-plane/seori-auth-agent-transport";
import {
  prepareWorkflowBundleCandidateFiles,
  workflowBundleCandidateCommand,
  workflowBundleCandidateTaskSchema,
  type WorkflowBundleCandidateTask,
} from "@/lib/control-plane/workflow-bundle-candidate-contract";

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[\p{L}\p{N}._@+ -]+(?:\/[\p{L}\p{N}._@+ -]+)*$/u;
const SENSITIVE_PATH = /(?:^|\/)(?:\.git|\.env(?:\.|$)|.*(?:credential|private[-_]?key|secret|token).*)(?:\/|$)/iu;
const MARKER_COMMENT = /<!--\s*(seori-run:[A-Za-z0-9._:/-]{1,170})\s*-->/gu;
// GitHub는 같은 repo의 #N뿐 아니라 `KEYWORD: owner/repo#N`도 종료 지시로
// 해석한다. PR body와 commit message에서 adapter가 추가하는 exact `Closes #N`
// 외의 지시를 모두 거부해야 다른 Issue를 함께 닫지 않는다.
const CLOSES_ISSUE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|#(\d+)|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/(\d+))\b/giu;
const PER_PAGE = 100;
const MAX_PAGES = 1_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function mutationControlPlaneRequestId(operationId: string, phase: string): string {
  return `ghm:${jsonDigest({ schemaVersion: 1, operationId, phase })}`;
}

function isControlPlaneConflict(error: unknown): boolean {
  return error instanceof Error && error.message === "SEORI_BACKOFFICE_REJECTED_409";
}

function publicText(max: number) {
  return z.string().min(1).max(max).refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) && !containsCredentialCandidate(value),
    "credential 후보와 제어 문자가 없는 공개 텍스트가 필요합니다.",
  );
}

const fileSchema = z.object({
  path: z.string().min(1).max(512).regex(SAFE_PATH).refine(
    (value) => !SENSITIVE_PATH.test(value) && !value.toLowerCase().startsWith(".github/workflows/"),
    "credential 및 workflow 경로는 READY_PR adapter가 수정하지 않습니다.",
  ),
  contentBase64: z.string().min(1).max(Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4),
  mode: z.enum(["100644", "100755"]).default("100644"),
}).strict();

export const githubReadyPrCommandSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/),
  repoId: z.string().regex(/^[1-9]\d{0,15}$/),
  repoFullName: z.string().regex(REPOSITORY),
  issueNumber: z.number().int().positive().nullable(),
  sourceSha: z.string().regex(SHA40),
  title: publicText(180),
  body: publicText(20_000),
  commitMessage: publicText(240),
  files: z.array(fileSchema).min(1).max(100),
}).strict();

export type GithubReadyPrCommand = z.infer<typeof githubReadyPrCommandSchema>;

export interface PreparedGithubFile {
  path: string;
  content: string;
  mode: "100644" | "100755";
  contentSha256: string;
}

export interface GithubRepositoryState {
  id: number;
  fullName: string;
  defaultBranch: string;
  defaultBranchSha: string;
}

export interface GithubIssueState {
  number: number;
  nodeId: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  updatedAt: Date;
}

export interface GithubPullRequestState {
  number: number;
  nodeId: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  headRef: string;
  headRepoFullName: string;
  headSha: string;
  baseRef: string;
  baseRepoFullName: string;
  baseSha: string;
  body: string;
}

export interface GithubCommitState {
  sha: string;
  treeSha: string;
  parentSha: string;
}

export interface GithubReadyPrRecoveryClaim {
  executionId: string;
  status: string;
  repoId: string;
  repoFullName: string;
  issueNumber: number | null;
  sourceSha: string;
  expectedHeadRef: string;
  expectedPullRequestMarker: string;
  duplicate: boolean;
}

export interface GithubReadyPrPort {
  installationId: string;
  getRepository(repoFullName: string): Promise<GithubRepositoryState>;
  getIssue(repoFullName: string, issueNumber: number): Promise<GithubIssueState>;
  listPullRequests(input: {
    repoFullName: string;
    state: "OPEN" | "ALL";
    page: number;
    perPage: number;
  }): Promise<GithubPullRequestState[]>;
  getRef(repoFullName: string, ref: string): Promise<{ sha: string } | null>;
  getCommit(repoFullName: string, sha: string): Promise<GithubCommitState | null>;
  createTree(input: {
    repoFullName: string;
    sourceSha: string;
    files: PreparedGithubFile[];
  }): Promise<{ sha: string }>;
  createCommit(input: {
    repoFullName: string;
    sourceSha: string;
    treeSha: string;
    message: string;
    date: Date;
  }): Promise<{ sha: string }>;
  createRef(input: { repoFullName: string; ref: string; sha: string }): Promise<void>;
  createPullRequest(input: {
    repoFullName: string;
    baseBranch: string;
    headRef: string;
    title: string;
    body: string;
  }): Promise<void>;
}

export interface GithubMutationControlPlane {
  recover(input: {
    requestId: string;
    body: {
      sessionId: string;
      workerPrincipalId: string;
      workerRuntimeBindingDigest: string;
    };
  }): Promise<GithubReadyPrRecoveryClaim>;
  authorize(input: {
    requestId: string;
    body: {
      sessionId: string;
      workerPrincipalId: string;
      workerRuntimeBindingDigest: string;
      action: "GITHUB_READY_PR_MUTATE";
      mutationIntentDigest: string;
      observation: AgentGithubObservation;
    };
  }): Promise<{
    executionId: string;
    action: "GITHUB_READY_PR_MUTATE";
    mutationIntentDigest: string;
    expectedHeadRef: string;
    expectedPullRequestMarker: string;
    expiresAt: Date;
    commitDate: Date;
    status: string;
    writeDisposition: "STEP_LEDGER";
    duplicate: boolean;
  }>;
  claimStep(input: {
    requestId: string;
    body: {
      sessionId: string;
      executionId: string;
      workerPrincipalId: string;
      workerRuntimeBindingDigest: string;
      stepKind: AgentGithubMutationStepKind;
    };
  }): Promise<{
    executionId: string;
    stepId: string;
    stepKind: AgentGithubMutationStepKind;
    stepStatus: string;
    generation: number;
    attemptId: string | null;
    expiresAt: Date | null;
    expectedTreeSha: string | null;
    expectedCommitSha: string | null;
    expectedHeadRef: string;
    expectedPullRequestMarker: string;
    sourceSha: string;
    commitDate: Date;
    writeDisposition: "EXECUTE_ONCE" | "READBACK_THEN_EXECUTE" | "READBACK_ONLY" | "ALREADY_VERIFIED";
    duplicate: boolean;
  }>;
  planStep(input: {
    requestId: string;
    body: {
      sessionId: string;
      executionId: string;
      stepId: string;
      attemptId: string;
      generation: number;
      workerPrincipalId: string;
      workerRuntimeBindingDigest: string;
      stepKind: "CREATE_COMMIT";
      expectedTreeSha: string;
      expectedCommitSha: string;
    };
  }): Promise<{
    executionId: string;
    stepId: string;
    attemptId: string;
    generation: number;
    status: string;
    expectedTreeSha: string;
    expectedCommitSha: string;
    duplicate: boolean;
  }>;
  completeStep(input: {
    requestId: string;
    body: {
      sessionId: string;
      executionId: string;
      stepId: string;
      attemptId: string;
      generation: number;
      workerPrincipalId: string;
      workerRuntimeBindingDigest: string;
      stepKind: AgentGithubMutationStepKind;
      observation: AgentGithubMutationStepObservation;
    };
  }): Promise<{
    executionId: string;
    stepId: string;
    attemptId: string;
    generation: number;
    status: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN";
    duplicate: boolean;
  }>;
  readback(input: {
    requestId: string;
    body: {
      sessionId: string;
      executionId: string;
      workerPrincipalId: string;
      workerRuntimeBindingDigest: string;
      observation: AgentGithubObservation;
    };
  }): Promise<{ executionId: string; status: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN"; duplicate: boolean }>;
}

export const GITHUB_AUTOMATION_COMMIT_IDENTITY = {
  name: "Seorilabs Automation",
  email: "automation@seorilabs.com",
} as const;

/** GitHub createCommit에 전달하는 exact identity/date로 Git commit object SHA를 미리 계산한다. */
export function deterministicGithubCommitSha(input: {
  treeSha: string;
  parentSha: string;
  message: string;
  date: Date;
}): string {
  if (!SHA40.test(input.treeSha) || !SHA40.test(input.parentSha) || Number.isNaN(input.date.getTime())) {
    throw new Error("GITHUB_READY_PR_COMMIT_PLAN_INVALID");
  }
  const timestamp = Math.floor(input.date.getTime() / 1_000);
  const identity = `${GITHUB_AUTOMATION_COMMIT_IDENTITY.name} <${GITHUB_AUTOMATION_COMMIT_IDENTITY.email}> ${timestamp} +0000`;
  const body = [
    `tree ${input.treeSha.toLowerCase()}`,
    `parent ${input.parentSha.toLowerCase()}`,
    `author ${identity}`,
    `committer ${identity}`,
    "",
    input.message,
  ].join("\n");
  const bytes = Buffer.from(body, "utf8");
  try {
    return createHash("sha1")
      .update(`commit ${bytes.length}\0`, "utf8")
      .update(bytes)
      .digest("hex");
  } finally {
    bytes.fill(0);
  }
}

function decodeFile(file: z.infer<typeof fileSchema>): PreparedGithubFile {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.contentBase64)) {
    throw new Error("GITHUB_READY_PR_FILE_BASE64_INVALID");
  }
  const bytes = Buffer.from(file.contentBase64, "base64");
  try {
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new Error("GITHUB_READY_PR_FILE_SIZE_INVALID");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content.includes("\0") || containsCredentialCandidate(content)) throw new Error("GITHUB_READY_PR_FILE_CONTENT_REJECTED");
    return {
      path: file.path,
      content,
      mode: file.mode,
      contentSha256: jsonDigest(content),
    };
  } finally {
    bytes.fill(0);
  }
}

export function prepareGithubReadyPrCommand(raw: unknown): {
  command: GithubReadyPrCommand;
  files: PreparedGithubFile[];
  mutationIntentDigest: string;
} {
  const command = githubReadyPrCommandSchema.parse(raw);
  if (
    command.body.includes("seori-run:")
    || hasClosingDirective(command.body)
    || hasClosingDirective(command.commitMessage)
  ) {
    throw new Error("GITHUB_READY_PR_RESERVED_BODY_DIRECTIVE");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = command.files.map((file) => {
    const normalizedPath = file.path.toLowerCase();
    if (seen.has(normalizedPath)) throw new Error("GITHUB_READY_PR_DUPLICATE_PATH");
    seen.add(normalizedPath);
    const prepared = decodeFile(file);
    totalBytes += Buffer.byteLength(prepared.content, "utf8");
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("GITHUB_READY_PR_TOTAL_SIZE_INVALID");
    return prepared;
  }).sort((left, right) => left.path.localeCompare(right.path));
  return { command, files, mutationIntentDigest: githubReadyPrMutationIntentDigest(command, files) };
}

/**
 * authorize가 고정하는 mutation 의도의 정본 digest다. adapter와 task 계약이 각자 계산하면
 * 한쪽만 바뀌어도 STEP_LEDGER binding이 조용히 어긋나므로 이 함수 하나만 쓴다.
 */
export function githubReadyPrMutationIntentDigest(
  command: {
    repoId: string;
    repoFullName: string;
    issueNumber: number | null;
    sourceSha: string;
    title: string;
    body: string;
    commitMessage: string;
  },
  files: readonly { path: string; mode: "100644" | "100755"; contentSha256: string }[],
): string {
  return jsonDigest({
    schemaVersion: 1,
    repoId: command.repoId,
    repoFullName: command.repoFullName.toLowerCase(),
    issueNumber: command.issueNumber,
    sourceSha: command.sourceSha.toLowerCase(),
    title: command.title,
    body: command.body,
    commitMessage: command.commitMessage,
    files: [...files]
      .map((file) => ({ path: file.path, mode: file.mode, contentSha256: file.contentSha256 }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
}

function markerFromBody(body: string): string | null {
  MARKER_COMMENT.lastIndex = 0;
  const matches = [...body.matchAll(MARKER_COMMENT)].map((match) => match[1]);
  MARKER_COMMENT.lastIndex = 0;
  return matches.length === 1 ? matches[0] : null;
}

function closesIssueFromBody(body: string): number | null {
  CLOSES_ISSUE.lastIndex = 0;
  const matches = [...body.matchAll(CLOSES_ISSUE)];
  CLOSES_ISSUE.lastIndex = 0;
  if (matches.length !== 1 || !matches[0][2]) return null;
  const value = Number(matches[0][2]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function hasClosingDirective(body: string): boolean {
  CLOSES_ISSUE.lastIndex = 0;
  const present = CLOSES_ISSUE.test(body);
  CLOSES_ISSUE.lastIndex = 0;
  return present;
}

async function readAllPullRequests(input: {
  github: GithubReadyPrPort;
  repoFullName: string;
  state: "OPEN" | "ALL";
}): Promise<{ pullRequests: GithubPullRequestState[]; pageCount: number }> {
  const pullRequests: GithubPullRequestState[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const current = await input.github.listPullRequests({
      repoFullName: input.repoFullName,
      state: input.state,
      page,
      perPage: PER_PAGE,
    });
    pullRequests.push(...current);
    if (current.length < PER_PAGE) return { pullRequests, pageCount: page };
  }
  throw new Error("GITHUB_READY_PR_PAGINATION_LIMIT");
}

async function readStableAllPullRequests(input: {
  github: GithubReadyPrPort;
  repoFullName: string;
}): Promise<{ pullRequests: GithubPullRequestState[]; pageCount: number }> {
  const first = await readAllPullRequests({ ...input, state: "ALL" });
  // A single response page has no page boundary from which a concurrent state
  // transition could skip an item. Avoid doubling the common read path while
  // retaining the identical second traversal for multi-page snapshots.
  if (first.pageCount === 1) return first;
  const second = await readAllPullRequests({ ...input, state: "ALL" });
  if (
    first.pageCount !== second.pageCount
    || jsonDigest(first.pullRequests as unknown as JsonValue)
      !== jsonDigest(second.pullRequests as unknown as JsonValue)
  ) {
    throw new Error("GITHUB_READY_PR_UNSTABLE_SNAPSHOT");
  }
  return second;
}

function publicOpenPullRequest(pullRequest: GithubPullRequestState, repoFullName: string) {
  const exactMarker = markerFromBody(pullRequest.body);
  const sameRepository = pullRequest.headRepoFullName.toLowerCase() === repoFullName.toLowerCase()
    && pullRequest.baseRepoFullName.toLowerCase() === repoFullName.toLowerCase();
  const marker = exactMarker && sameRepository
    ? exactMarker
    : (exactMarker || pullRequest.headRef.startsWith("refs/heads/seori/"))
    ? `unmanaged-seori-pr:${pullRequest.number}`
    : null;
  if (!marker || pullRequest.state !== "OPEN") return null;
  return {
    number: pullRequest.number,
    nodeId: pullRequest.nodeId,
    url: pullRequest.url,
    state: "OPEN" as const,
    draft: pullRequest.draft,
    headRef: pullRequest.headRef,
    headSha: pullRequest.headSha,
    baseRef: pullRequest.baseRef,
    baseSha: pullRequest.baseSha,
    marker,
    closesIssueNumber: closesIssueFromBody(pullRequest.body),
  };
}

function publicTargetPullRequest(
  pullRequest: GithubPullRequestState,
  expectedMarker: string,
  expectedHeadRef: string,
  repoFullName: string,
) {
  if (
    markerFromBody(pullRequest.body) !== expectedMarker
    || pullRequest.headRef !== expectedHeadRef
    || pullRequest.headRepoFullName.toLowerCase() !== repoFullName.toLowerCase()
    || pullRequest.baseRepoFullName.toLowerCase() !== repoFullName.toLowerCase()
  ) return null;
  return {
    number: pullRequest.number,
    nodeId: pullRequest.nodeId,
    url: pullRequest.url,
    state: pullRequest.state,
    draft: pullRequest.draft,
    headRef: pullRequest.headRef,
    headSha: pullRequest.headSha,
    baseRef: pullRequest.baseRef,
    baseSha: pullRequest.baseSha,
    marker: expectedMarker,
    closesIssueNumber: closesIssueFromBody(pullRequest.body),
  };
}

export async function observeGithubReadyPr(input: {
  github: GithubReadyPrPort;
  repoFullName: string;
  issueNumber: number | null;
  expectedTarget?: { headRef: string; marker: string };
  now?: Date;
}): Promise<AgentGithubObservation> {
  const observedAt = input.now ?? new Date();
  const repository = await input.github.getRepository(input.repoFullName);
  const issue = input.issueNumber === null
    ? null
    : await input.github.getIssue(input.repoFullName, input.issueNumber);
  // OPEN page-number pagination can skip an item when an earlier PR closes
  // between pages. PR records cannot be deleted, so enumerate the
  // created-ascending ALL sequence once and derive both views from it.
  const all = await readStableAllPullRequests({ github: input.github, repoFullName: input.repoFullName });
  const openAutopilotPullRequests = all.pullRequests
    .map((pullRequest) => publicOpenPullRequest(pullRequest, repository.fullName))
    .filter((pullRequest): pullRequest is NonNullable<ReturnType<typeof publicOpenPullRequest>> => Boolean(pullRequest));
  const pageCount = all.pageCount;
  let mutationTarget: AgentGithubObservation["mutationTarget"] = null;
  if (input.expectedTarget) {
    const head = await input.github.getRef(input.repoFullName, input.expectedTarget.headRef);
    mutationTarget = {
      expectedHeadRef: input.expectedTarget.headRef,
      expectedMarker: input.expectedTarget.marker,
      headState: head ? "PRESENT" : "ABSENT",
      headSha: head?.sha ?? null,
      complete: true,
      pageCount: all.pageCount,
      terminalCursor: null,
      pullRequests: all.pullRequests
        .map((pullRequest) => publicTargetPullRequest(
          pullRequest,
          input.expectedTarget!.marker,
          input.expectedTarget!.headRef,
          repository.fullName,
        ))
        .filter((pullRequest): pullRequest is NonNullable<ReturnType<typeof publicTargetPullRequest>> => Boolean(pullRequest)),
    };
  }
  const snapshot = {
    schemaVersion: 1 as const,
    githubInstallationId: input.github.installationId,
    providerSnapshotId: "pending",
    complete: true as const,
    pageCount,
    terminalCursor: null,
    observedAt,
    repoId: String(repository.id),
    repoFullName: repository.fullName,
    defaultBranchRef: `refs/heads/${repository.defaultBranch}`,
    defaultBranchSha: repository.defaultBranchSha,
    issue,
    openAutopilotPullRequests,
    mutationTarget,
  };
  const providerSnapshotId = `ghobs:${jsonDigest({
    ...snapshot,
    observedAt: observedAt.toISOString(),
    providerSnapshotId: null,
  } as unknown as JsonValue).slice(0, 48)}`;
  return agentGithubObservationSchema.parse({ ...snapshot, providerSnapshotId });
}

export async function observeGithubMutationStep(input: {
  github: GithubReadyPrPort;
  repoFullName: string;
  issueNumber: number | null;
  stepKind: AgentGithubMutationStepKind;
  expectedHeadRef: string;
  expectedMarker: string;
  expectedTreeSha: string | null;
  expectedCommitSha: string | null;
  now?: Date;
}): Promise<AgentGithubMutationStepObservation> {
  const observedAt = input.now ?? new Date();
  const repository = await input.github.getRepository(input.repoFullName);
  const issue = input.issueNumber === null
    ? null
    : await input.github.getIssue(input.repoFullName, input.issueNumber);
  const all = await readStableAllPullRequests({ github: input.github, repoFullName: input.repoFullName });
  const openAutopilotPullRequests = all.pullRequests
    .map((pullRequest) => publicOpenPullRequest(pullRequest, repository.fullName))
    .filter((pullRequest): pullRequest is NonNullable<ReturnType<typeof publicOpenPullRequest>> => Boolean(pullRequest));
  const commit = input.expectedCommitSha
    ? await input.github.getCommit(input.repoFullName, input.expectedCommitSha)
    : null;
  const head = await input.github.getRef(input.repoFullName, input.expectedHeadRef);
  const pullRequests = input.stepKind === "CREATE_PR"
    ? all.pullRequests
    .map((pullRequest) => publicTargetPullRequest(
      pullRequest,
      input.expectedMarker,
      input.expectedHeadRef,
      repository.fullName,
    ))
    .filter((pullRequest): pullRequest is NonNullable<ReturnType<typeof publicTargetPullRequest>> => Boolean(pullRequest))
    : [];
  const snapshot = {
    schemaVersion: 1 as const,
    stepKind: input.stepKind,
    githubInstallationId: input.github.installationId,
    providerSnapshotId: "pending",
    complete: true as const,
    observedAt,
    repoId: String(repository.id),
    repoFullName: repository.fullName,
    defaultBranchRef: `refs/heads/${repository.defaultBranch}`,
    defaultBranchSha: repository.defaultBranchSha,
    issue,
    expectedHeadRef: input.expectedHeadRef,
    expectedPullRequestMarker: input.expectedMarker,
    expectedTreeSha: input.expectedTreeSha,
    expectedCommitSha: input.expectedCommitSha,
    commit,
    headSha: head?.sha ?? null,
    openAutopilotPullRequests,
    pullRequests,
  };
  const providerSnapshotId = `ghstep:${jsonDigest({
    ...snapshot,
    observedAt: observedAt.toISOString(),
    issue: issue ? { ...issue, updatedAt: issue.updatedAt.toISOString() } : null,
    providerSnapshotId: null,
  } as unknown as JsonValue).slice(0, 48)}`;
  return agentGithubMutationStepObservationSchema.parse({ ...snapshot, providerSnapshotId });
}

function mutationStepIssueEligible(issue: AgentGithubMutationStepObservation["issue"]): boolean {
  if (!issue || issue.state !== "OPEN") return false;
  const labels = issue.labels.map((label) => label.toLowerCase());
  return labels.includes("autopilot")
    && !labels.some((label) => label === "blocked" || label === "no-autopilot" || label.startsWith("approval:"));
}

function exactStepCommit(observation: AgentGithubMutationStepObservation): boolean {
  return Boolean(
    observation.commit
    && observation.expectedTreeSha
    && observation.expectedCommitSha
    && observation.commit.sha.toLowerCase() === observation.expectedCommitSha.toLowerCase()
    && observation.commit.treeSha.toLowerCase() === observation.expectedTreeSha.toLowerCase(),
  );
}

function mutationStepBasePreconditions(input: {
  observation: AgentGithubMutationStepObservation;
  command: GithubReadyPrCommand;
  expectedDefaultBranchRef: string;
  expectedHeadRef: string;
  expectedMarker: string;
}): boolean {
  const { observation, command } = input;
  return observation.repoId === command.repoId
    && observation.repoFullName.toLowerCase() === command.repoFullName.toLowerCase()
    && observation.defaultBranchRef === input.expectedDefaultBranchRef
    && observation.defaultBranchSha.toLowerCase() === command.sourceSha.toLowerCase()
    && observation.expectedHeadRef === input.expectedHeadRef
    && observation.expectedPullRequestMarker === input.expectedMarker
    && (observation.issue?.number ?? null) === command.issueNumber
    && (command.issueNumber === null || mutationStepIssueEligible(observation.issue))
    && (observation.stepKind !== "CREATE_COMMIT" || observation.headSha === null)
    && observation.openAutopilotPullRequests.length === 0;
}

export async function executeGithubReadyPr(input: {
  operationId: string;
  workerPrincipalId: WorkerPrincipal;
  workerRuntimeBindingDigest: string;
  rawCommand: unknown;
  github: GithubReadyPrPort;
  controlPlane: GithubMutationControlPlane;
  clock?: () => Date;
}): Promise<{
  executionId: string;
  status: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN";
  writeAttempted: boolean;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
}> {
  const prepared = prepareGithubReadyPrCommand(input.rawCommand);
  return executePreparedGithubReadyPr({ ...input, prepared });
}

export async function executePreparedGithubReadyPr(input: {
  operationId: string;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  prepared: {
    command: GithubReadyPrCommand;
    files: PreparedGithubFile[];
    mutationIntentDigest: string;
  };
  github: GithubReadyPrPort;
  controlPlane: GithubMutationControlPlane;
  clock?: () => Date;
}): Promise<{
  executionId: string;
  status: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN";
  writeAttempted: boolean;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
}> {
  const prepared = input.prepared;
  const { command } = prepared;
  const now = input.clock ?? (() => new Date());
  const preObservation = await observeGithubReadyPr({
    github: input.github,
    repoFullName: command.repoFullName,
    issueNumber: command.issueNumber,
    now: now(),
  });
  if (
    preObservation.repoId !== command.repoId
    ||
    preObservation.repoFullName.toLowerCase() !== command.repoFullName.toLowerCase()
    || preObservation.defaultBranchSha.toLowerCase() !== command.sourceSha.toLowerCase()
  ) throw new Error("GITHUB_READY_PR_SOURCE_BINDING_MISMATCH");
  const authorizationBody = {
    sessionId: command.sessionId,
    workerPrincipalId: input.workerPrincipalId,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
    action: "GITHUB_READY_PR_MUTATE" as const,
    mutationIntentDigest: prepared.mutationIntentDigest,
    observation: preObservation,
  };
  const authorization = await input.controlPlane.authorize({
    requestId: mutationControlPlaneRequestId(input.operationId, "authorize"),
    body: authorizationBody,
  });
  if (
    authorization.action !== "GITHUB_READY_PR_MUTATE"
    || authorization.mutationIntentDigest.toLowerCase() !== prepared.mutationIntentDigest
    || !SHA256.test(authorization.mutationIntentDigest)
    || authorization.writeDisposition !== "STEP_LEDGER"
    || authorization.commitDate.getTime() > authorization.expiresAt.getTime()
  ) throw new Error("GITHUB_READY_PR_AUTHORIZATION_BINDING_MISMATCH");

  let writeAttempted = false;
  const stepKinds: AgentGithubMutationStepKind[] = ["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"];
  for (const stepKind of stepKinds) {
    const claimBody = {
      sessionId: command.sessionId,
      executionId: authorization.executionId,
      workerPrincipalId: input.workerPrincipalId,
      workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
      stepKind,
    };
    const stableClaimRequestId = mutationControlPlaneRequestId(input.operationId, `step:${stepKind}:claim`);
    let claim: Awaited<ReturnType<GithubMutationControlPlane["claimStep"]>>;
    try {
      claim = await input.controlPlane.claimStep({ requestId: stableClaimRequestId, body: claimBody });
    } catch (error) {
      if (!isControlPlaneConflict(error)) throw error;
      // 같은 logical operation의 이전 attempt가 terminal/stale이면 새 generation을
      // 받아야 한다. 아직 active면 control-plane CAS가 이 재시도도 거부한다.
      claim = await input.controlPlane.claimStep({
        requestId: mutationControlPlaneRequestId(
          input.operationId,
          `step:${stepKind}:claim:resume:${randomUUID()}`,
        ),
        body: claimBody,
      });
    }
    if (
      claim.executionId !== authorization.executionId
      || claim.stepKind !== stepKind
      || claim.sourceSha.toLowerCase() !== command.sourceSha.toLowerCase()
      || claim.expectedHeadRef !== authorization.expectedHeadRef
      || claim.expectedPullRequestMarker !== authorization.expectedPullRequestMarker
      || claim.commitDate.getTime() !== authorization.commitDate.getTime()
    ) throw new Error("GITHUB_READY_PR_STEP_CLAIM_BINDING_MISMATCH");
    if (claim.writeDisposition === "ALREADY_VERIFIED") continue;
    if (!claim.attemptId || !claim.expiresAt || claim.expiresAt <= now()) {
      throw new Error("GITHUB_READY_PR_STEP_CLAIM_INVALID");
    }

    let expectedTreeSha = claim.expectedTreeSha;
    let expectedCommitSha = claim.expectedCommitSha;
    if (stepKind === "CREATE_COMMIT" && (!expectedTreeSha || !expectedCommitSha)) {
      const beforeTree = await observeGithubMutationStep({
        github: input.github,
        repoFullName: command.repoFullName,
        issueNumber: command.issueNumber,
        stepKind,
        expectedHeadRef: claim.expectedHeadRef,
        expectedMarker: claim.expectedPullRequestMarker,
        expectedTreeSha: null,
        expectedCommitSha: null,
        now: now(),
      });
      if (!mutationStepBasePreconditions({
        observation: beforeTree,
        command,
        expectedDefaultBranchRef: preObservation.defaultBranchRef,
        expectedHeadRef: claim.expectedHeadRef,
        expectedMarker: claim.expectedPullRequestMarker,
      }) || claim.expiresAt <= now()) {
        break;
      }
      const tree = await input.github.createTree({
        repoFullName: command.repoFullName,
        sourceSha: command.sourceSha.toLowerCase(),
        files: prepared.files,
      });
      expectedTreeSha = tree.sha.toLowerCase();
      expectedCommitSha = deterministicGithubCommitSha({
        treeSha: expectedTreeSha,
        parentSha: command.sourceSha,
        message: command.commitMessage,
        date: claim.commitDate,
      });
      const planBody = {
        sessionId: command.sessionId,
        executionId: claim.executionId,
        stepId: claim.stepId,
        attemptId: claim.attemptId,
        generation: claim.generation,
        workerPrincipalId: input.workerPrincipalId,
        workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
        stepKind,
        expectedTreeSha,
        expectedCommitSha,
      };
      const plan = await input.controlPlane.planStep({
        requestId: mutationControlPlaneRequestId(
          input.operationId,
          `step:${stepKind}:generation:${claim.generation}:plan`,
        ),
        body: planBody,
      });
      if (
        plan.executionId !== claim.executionId
        || plan.stepId !== claim.stepId
        || plan.attemptId !== claim.attemptId
        || plan.generation !== claim.generation
        || plan.expectedTreeSha.toLowerCase() !== expectedTreeSha
        || plan.expectedCommitSha.toLowerCase() !== expectedCommitSha
      ) throw new Error("GITHUB_READY_PR_COMMIT_PLAN_BINDING_MISMATCH");
    }
    if (!expectedTreeSha || !expectedCommitSha) {
      throw new Error("GITHUB_READY_PR_STEP_EXPECTATION_MISSING");
    }

    const beforeWrite = await observeGithubMutationStep({
      github: input.github,
      repoFullName: command.repoFullName,
      issueNumber: command.issueNumber,
      stepKind,
      expectedHeadRef: claim.expectedHeadRef,
      expectedMarker: claim.expectedPullRequestMarker,
      expectedTreeSha,
      expectedCommitSha,
      now: now(),
    });
    const basePreconditions = mutationStepBasePreconditions({
      observation: beforeWrite,
      command,
      expectedDefaultBranchRef: preObservation.defaultBranchRef,
      expectedHeadRef: claim.expectedHeadRef,
      expectedMarker: claim.expectedPullRequestMarker,
    });
    if (basePreconditions && claim.expiresAt > now()) {
      try {
        if (stepKind === "CREATE_COMMIT" && beforeWrite.commit === null) {
          writeAttempted = true;
          const commit = await input.github.createCommit({
            repoFullName: command.repoFullName,
            sourceSha: command.sourceSha.toLowerCase(),
            treeSha: expectedTreeSha,
            message: command.commitMessage,
            date: claim.commitDate,
          });
          if (commit.sha.toLowerCase() !== expectedCommitSha) {
            throw new Error("GITHUB_READY_PR_COMMIT_SHA_MISMATCH");
          }
        } else if (
          stepKind === "CREATE_REF"
          && exactStepCommit(beforeWrite)
          && beforeWrite.headSha === null
        ) {
          writeAttempted = true;
          await input.github.createRef({
            repoFullName: command.repoFullName,
            ref: claim.expectedHeadRef,
            sha: expectedCommitSha,
          });
        } else if (
          stepKind === "CREATE_PR"
          && exactStepCommit(beforeWrite)
          && beforeWrite.headSha?.toLowerCase() === expectedCommitSha
          && beforeWrite.pullRequests.length === 0
        ) {
          writeAttempted = true;
          const body = [
            command.body.trim(),
            ...(command.issueNumber === null ? [] : [`Closes #${command.issueNumber}`]),
            `<!-- ${claim.expectedPullRequestMarker} -->`,
          ].join("\n\n");
          await input.github.createPullRequest({
            repoFullName: command.repoFullName,
            baseBranch: beforeWrite.defaultBranchRef.replace(/^refs\/heads\//u, ""),
            headRef: claim.expectedHeadRef,
            title: command.title,
            body,
          });
        }
      } catch {
        // Provider 응답 유실과 부분 적용을 구분할 수 없으므로 같은 write를 반복하지 않고 즉시 readback한다.
      }
    }

    const afterWrite = await observeGithubMutationStep({
      github: input.github,
      repoFullName: command.repoFullName,
      issueNumber: command.issueNumber,
      stepKind,
      expectedHeadRef: claim.expectedHeadRef,
      expectedMarker: claim.expectedPullRequestMarker,
      expectedTreeSha,
      expectedCommitSha,
      now: now(),
    });
    const completionBody = {
      sessionId: command.sessionId,
      executionId: claim.executionId,
      stepId: claim.stepId,
      attemptId: claim.attemptId,
      generation: claim.generation,
      workerPrincipalId: input.workerPrincipalId,
      workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
      stepKind,
      observation: afterWrite,
    };
    const completion = await input.controlPlane.completeStep({
      requestId: mutationControlPlaneRequestId(
        input.operationId,
        `step:${stepKind}:generation:${claim.generation}:complete`,
      ),
      body: completionBody,
    });
    if (
      completion.executionId !== claim.executionId
      || completion.stepId !== claim.stepId
      || completion.attemptId !== claim.attemptId
      || completion.generation !== claim.generation
    ) throw new Error("GITHUB_READY_PR_STEP_COMPLETION_BINDING_MISMATCH");
    if (completion.status !== "VERIFIED") break;
  }

  const postObservation = await observeGithubReadyPr({
    github: input.github,
    repoFullName: command.repoFullName,
    issueNumber: command.issueNumber,
    expectedTarget: {
      headRef: authorization.expectedHeadRef,
      marker: authorization.expectedPullRequestMarker,
    },
    now: now(),
  });
  const readbackBody = {
    sessionId: command.sessionId,
    executionId: authorization.executionId,
    workerPrincipalId: input.workerPrincipalId,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
    observation: postObservation,
  };
  const readback = await input.controlPlane.readback({
    requestId: mutationControlPlaneRequestId(
      input.operationId,
      `readback:${postObservation.providerSnapshotId}`,
    ),
    body: readbackBody,
  });
  const target = postObservation.mutationTarget?.pullRequests.length === 1
    ? postObservation.mutationTarget.pullRequests[0]
    : null;
  return {
    executionId: readback.executionId,
    status: readback.status,
    writeAttempted,
    ...(readback.status === "VERIFIED" && target ? {
      pullRequestNumber: target.number,
      pullRequestUrl: target.url,
    } : {}),
  };
}

export async function executeWorkflowBundleCandidateReadyPr(input: {
  operationId: string;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  task: WorkflowBundleCandidateTask;
  sessionId: string;
  github: GithubReadyPrPort;
  controlPlane: GithubMutationControlPlane;
  clock?: () => Date;
}) {
  const task = workflowBundleCandidateTaskSchema.parse(input.task);
  const command = workflowBundleCandidateCommand(task, input.sessionId) as GithubReadyPrCommand;
  return executePreparedGithubReadyPr({
    ...input,
    prepared: {
      command,
      files: prepareWorkflowBundleCandidateFiles(task),
      mutationIntentDigest: task.mutation.intentDigest,
    },
  });
}

export async function recoverGithubReadyPr(input: {
  operationId: string;
  sessionId: string;
  workerPrincipalId: string;
  workerRuntimeBindingDigest: string;
  recovery: GithubReadyPrRecoveryClaim;
  github: GithubReadyPrPort;
  controlPlane: GithubMutationControlPlane;
  clock?: () => Date;
}): Promise<{
  executionId: string;
  status: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN";
  writeAttempted: false;
  safeToResume: boolean;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
}> {
  const now = input.clock ?? (() => new Date());
  const stepKinds: AgentGithubMutationStepKind[] = ["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"];
  let verifiedPrefixLength = 0;
  let firstUnappliedOrdinal: number | null = null;
  for (const stepKind of stepKinds) {
    const claim = await input.controlPlane.claimStep({
      requestId: mutationControlPlaneRequestId(input.operationId, `recovery:${stepKind}:claim`),
      body: {
        sessionId: input.sessionId,
        executionId: input.recovery.executionId,
        workerPrincipalId: input.workerPrincipalId,
        workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
        stepKind,
      },
    });
    if (
      claim.executionId !== input.recovery.executionId
      || claim.stepKind !== stepKind
      || claim.expectedHeadRef !== input.recovery.expectedHeadRef
      || claim.expectedPullRequestMarker !== input.recovery.expectedPullRequestMarker
      || claim.sourceSha.toLowerCase() !== input.recovery.sourceSha.toLowerCase()
    ) throw new Error("GITHUB_READY_PR_RECOVERY_CLAIM_BINDING_MISMATCH");
    if (claim.writeDisposition === "ALREADY_VERIFIED") {
      verifiedPrefixLength += 1;
      continue;
    }
    if (
      claim.writeDisposition !== "READBACK_ONLY"
      || !claim.attemptId
      || !claim.expiresAt
      || claim.expiresAt <= now()
    ) throw new Error("GITHUB_READY_PR_RECOVERY_CLAIM_INVALID");
    const observation = await observeGithubMutationStep({
      github: input.github,
      repoFullName: input.recovery.repoFullName,
      issueNumber: input.recovery.issueNumber,
      stepKind,
      expectedHeadRef: claim.expectedHeadRef,
      expectedMarker: claim.expectedPullRequestMarker,
      expectedTreeSha: claim.expectedTreeSha,
      expectedCommitSha: claim.expectedCommitSha,
      now: now(),
    });
    const completion = await input.controlPlane.completeStep({
      requestId: mutationControlPlaneRequestId(
        input.operationId,
        `recovery:${stepKind}:generation:${claim.generation}:complete`,
      ),
      body: {
        sessionId: input.sessionId,
        executionId: claim.executionId,
        stepId: claim.stepId,
        attemptId: claim.attemptId,
        generation: claim.generation,
        workerPrincipalId: input.workerPrincipalId,
        workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
        stepKind,
        observation,
      },
    });
    if (completion.status === "VERIFIED") {
      verifiedPrefixLength += 1;
      continue;
    }
    if (completion.status === "NOT_APPLIED") {
      firstUnappliedOrdinal = stepKinds.indexOf(stepKind) + 1;
    }
    break;
  }

  const postObservation = await observeGithubReadyPr({
    github: input.github,
    repoFullName: input.recovery.repoFullName,
    issueNumber: input.recovery.issueNumber,
    expectedTarget: {
      headRef: input.recovery.expectedHeadRef,
      marker: input.recovery.expectedPullRequestMarker,
    },
    now: now(),
  });
  const readback = await input.controlPlane.readback({
    requestId: mutationControlPlaneRequestId(
      input.operationId,
      `recovery:readback:${postObservation.providerSnapshotId}`,
    ),
    body: {
      sessionId: input.sessionId,
      executionId: input.recovery.executionId,
      workerPrincipalId: input.workerPrincipalId,
      workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
      observation: postObservation,
    },
  });
  const target = postObservation.mutationTarget?.pullRequests.length === 1
    ? postObservation.mutationTarget.pullRequests[0]
    : null;
  return {
    executionId: readback.executionId,
    status: readback.status,
    writeAttempted: false,
    // 서버는 settlement 때 durable step ledger와 현재 readback을 다시 검증한다.
    // 여기서는 worker가 RESULT_UNKNOWN을 무조건 BLOCKED로 오인하지 않도록
    // 연속 VERIFIED prefix 바로 다음 단계가 NOT_APPLIED였다는 공개 힌트만 준다.
    safeToResume: readback.status === "RESULT_UNKNOWN"
      && verifiedPrefixLength > 0
      && firstUnappliedOrdinal === verifiedPrefixLength + 1,
    ...(readback.status === "VERIFIED" && target ? {
      pullRequestNumber: target.number,
      pullRequestUrl: target.url,
    } : {}),
  };
}
