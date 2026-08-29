import { TextDecoder } from "node:util";
import { z } from "zod";

import {
  agentGithubMutationAuthorizeSchema,
  agentGithubMutationReadbackSchema,
  agentGithubObservationSchema,
  type AgentGithubObservation,
} from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import type { WorkerPrincipal } from "@/lib/control-plane/seori-auth-agent-transport";

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[\p{L}\p{N}._@+ -]+(?:\/[\p{L}\p{N}._@+ -]+)*$/u;
const SENSITIVE_PATH = /(?:^|\/)(?:\.git|\.env(?:\.|$)|.*(?:credential|private[-_]?key|secret|token).*)(?:\/|$)/iu;
const SENSITIVE_CONTENT = /(?:-----BEGIN\s+(?:(?:RSA|EC|OPENSSH)\s+)?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\b(?:password|passwd|pwd|totp(?:[_-]?seed)?|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9+/_=.-]{8,})/iu;
const MARKER_COMMENT = /<!--\s*(seori-run:[A-Za-z0-9._:/-]{1,170})\s*-->/gu;
// GitHub는 같은 repo의 #N뿐 아니라 `KEYWORD: owner/repo#N`도 종료 지시로
// 해석한다. PR body와 commit message에서 adapter가 추가하는 exact `Closes #N`
// 외의 지시를 모두 거부해야 다른 Issue를 함께 닫지 않는다.
const CLOSES_ISSUE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|#(\d+)|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/(\d+))\b/giu;
const PER_PAGE = 100;
const MAX_PAGES = 1_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function publicText(max: number) {
  return z.string().min(1).max(max).refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) && !SENSITIVE_CONTENT.test(value),
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
  applyReadyPr(input: {
    repoFullName: string;
    sourceSha: string;
    expectedHeadRef: string;
    expectedMarker: string;
    issueNumber: number | null;
    title: string;
    body: string;
    commitMessage: string;
    files: PreparedGithubFile[];
  }): Promise<void>;
}

export interface GithubMutationControlPlane {
  authorize(input: {
    requestId: string;
    body: z.infer<typeof agentGithubMutationAuthorizeSchema>;
  }): Promise<{
    executionId: string;
    action: "GITHUB_READY_PR_MUTATE";
    mutationIntentDigest: string;
    expectedHeadRef: string;
    expectedPullRequestMarker: string;
    expiresAt: Date;
    status: string;
    writeDisposition: "EXECUTE_ONCE" | "READBACK_ONLY";
    duplicate: boolean;
  }>;
  readback(input: {
    requestId: string;
    body: z.infer<typeof agentGithubMutationReadbackSchema>;
  }): Promise<{ executionId: string; status: "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN"; duplicate: boolean }>;
}

function decodeFile(file: z.infer<typeof fileSchema>): PreparedGithubFile {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.contentBase64)) {
    throw new Error("GITHUB_READY_PR_FILE_BASE64_INVALID");
  }
  const bytes = Buffer.from(file.contentBase64, "base64");
  try {
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new Error("GITHUB_READY_PR_FILE_SIZE_INVALID");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content.includes("\0") || SENSITIVE_CONTENT.test(content)) throw new Error("GITHUB_READY_PR_FILE_CONTENT_REJECTED");
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
  const mutationIntentDigest = jsonDigest({
    schemaVersion: 1,
    sessionId: command.sessionId,
    repoId: command.repoId,
    repoFullName: command.repoFullName.toLowerCase(),
    issueNumber: command.issueNumber,
    sourceSha: command.sourceSha.toLowerCase(),
    title: command.title,
    body: command.body,
    commitMessage: command.commitMessage,
    files: files.map((file) => ({ path: file.path, mode: file.mode, contentSha256: file.contentSha256 })),
  });
  return { command, files, mutationIntentDigest };
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
  const open = await readAllPullRequests({ github: input.github, repoFullName: input.repoFullName, state: "OPEN" });
  const openAutopilotPullRequests = open.pullRequests
    .map((pullRequest) => publicOpenPullRequest(pullRequest, repository.fullName))
    .filter((pullRequest): pullRequest is NonNullable<ReturnType<typeof publicOpenPullRequest>> => Boolean(pullRequest));
  let pageCount = open.pageCount;
  let mutationTarget: AgentGithubObservation["mutationTarget"] = null;
  if (input.expectedTarget) {
    const [head, all] = await Promise.all([
      input.github.getRef(input.repoFullName, input.expectedTarget.headRef),
      readAllPullRequests({ github: input.github, repoFullName: input.repoFullName, state: "ALL" }),
    ]);
    pageCount += all.pageCount;
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

function sameWritePreconditions(left: AgentGithubObservation, right: AgentGithubObservation): boolean {
  return left.repoId === right.repoId
    && left.repoFullName.toLowerCase() === right.repoFullName.toLowerCase()
    && left.defaultBranchRef === right.defaultBranchRef
    && left.defaultBranchSha.toLowerCase() === right.defaultBranchSha.toLowerCase()
    && (left.issue?.number ?? null) === (right.issue?.number ?? null)
    && left.issue?.state === right.issue?.state
    && JSON.stringify(left.issue?.labels.map((label) => label.toLowerCase()).sort() ?? [])
      === JSON.stringify(right.issue?.labels.map((label) => label.toLowerCase()).sort() ?? [])
    && right.openAutopilotPullRequests.length === 0
    && right.mutationTarget?.headState === "ABSENT"
    && right.mutationTarget.pullRequests.length === 0;
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
  const authorizationBody = agentGithubMutationAuthorizeSchema.parse({
    sessionId: command.sessionId,
    workerPrincipalId: input.workerPrincipalId,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
    action: "GITHUB_READY_PR_MUTATE",
    mutationIntentDigest: prepared.mutationIntentDigest,
    observation: preObservation,
  });
  const authorization = await input.controlPlane.authorize({
    requestId: `${input.operationId}:authorize`,
    body: authorizationBody,
  });
  if (
    authorization.action !== "GITHUB_READY_PR_MUTATE"
    || authorization.mutationIntentDigest.toLowerCase() !== prepared.mutationIntentDigest
    || !SHA256.test(authorization.mutationIntentDigest)
  ) throw new Error("GITHUB_READY_PR_AUTHORIZATION_BINDING_MISMATCH");

  let writeAttempted = false;
  if (authorization.writeDisposition === "EXECUTE_ONCE") {
    if (authorization.duplicate || authorization.status !== "CONSUMED" || authorization.expiresAt <= now()) {
      throw new Error("GITHUB_READY_PR_AUTHORIZATION_INVALID");
    }
    const beforeWrite = await observeGithubReadyPr({
      github: input.github,
      repoFullName: command.repoFullName,
      issueNumber: command.issueNumber,
      expectedTarget: {
        headRef: authorization.expectedHeadRef,
        marker: authorization.expectedPullRequestMarker,
      },
      now: now(),
    });
    // complete pagination이 오래 걸려 session/JIT grant가 만료될 수 있으므로 실제
    // mutation 진입 직전에 TTL을 다시 확인한다. 만료 시 write 없이 signed readback만 한다.
    if (sameWritePreconditions(preObservation, beforeWrite) && authorization.expiresAt > now()) {
      writeAttempted = true;
      try {
        await input.github.applyReadyPr({
          repoFullName: command.repoFullName,
          sourceSha: command.sourceSha.toLowerCase(),
          expectedHeadRef: authorization.expectedHeadRef,
          expectedMarker: authorization.expectedPullRequestMarker,
          issueNumber: command.issueNumber,
          title: command.title,
          body: command.body,
          commitMessage: command.commitMessage,
          files: prepared.files,
        });
      } catch {
        // GitHub가 일부 mutation을 적용한 뒤 응답을 잃었을 수 있다. 재시도하지 않고 readback으로만 판정한다.
      }
    }
  } else if (authorization.writeDisposition !== "READBACK_ONLY" || !authorization.duplicate) {
    throw new Error("GITHUB_READY_PR_WRITE_DISPOSITION_INVALID");
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
  const readbackBody = agentGithubMutationReadbackSchema.parse({
    executionId: authorization.executionId,
    workerPrincipalId: input.workerPrincipalId,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
    observation: postObservation,
  });
  const readback = await input.controlPlane.readback({
    requestId: `${input.operationId}:readback`,
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
