import type { NextRequest } from "next/server";
import { repositoryDefaultBranchRef } from "@/lib/control-plane/repository-source-ref";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWSHeaderParameters,
} from "jose";

const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_ACTIONS_AUDIENCE = "seorilabs-control-plane";
const GITHUB_ACTIONS_JWKS = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
  { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 },
);
const SEORILABS_ORGANIZATION_ID = "283115031";
const STATIC_CALLER_PATH = ".github/workflows/org-contract.yml";
const BUILD_CALLER_PATH = ".github/workflows/android-build-only.yml";
export const GITHUB_ACTIONS_STATIC_WORKFLOW_PATHS = {
  javascript: ".github/workflows/js-static-checks-v1.yml",
  godot: ".github/workflows/godot-checks-v3.yml",
} as const;
export type GitHubActionsStaticWorkflowPath =
  (typeof GITHUB_ACTIONS_STATIC_WORKFLOW_PATHS)[keyof typeof GITHUB_ACTIONS_STATIC_WORKFLOW_PATHS];
export const GITHUB_ACTIONS_BUILD_WORKFLOW_PATHS = {
  "react-native-android": ".github/workflows/rn-build-android-cloud-v2.yml",
  "godot-android": ".github/workflows/godot-build-android-cloud-v2.yml",
} as const;
export type GitHubActionsBuildProfile = keyof typeof GITHUB_ACTIONS_BUILD_WORKFLOW_PATHS;
export type GitHubActionsBuildManifestMode = "CANDIDATE" | "APPROVED" | "RELEASE";
const GITHUB_ACTIONS_BUILD_CANARIES = {
  "1250442131": { fullName: "seorilabs/happy-farm", buildProfile: "react-native-android" },
  "1265192029": { fullName: "seorilabs/lizard-tycoon", buildProfile: "godot-android" },
} as const;
const SHA = /^[0-9a-f]{40}$/;
const STABLE_RELEASE_TAG = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const PLAN_IDENTITY = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type GitHubActionsOidcVerifier = (token: string) => Promise<{
  payload: JWTPayload;
  protectedHeader: JWSHeaderParameters;
}>;

export interface GitHubActionsStaticManifestIdentity {
  repositoryId: string;
  fullName: string;
  applicationSourceSha: string;
  bindingSourceSha: string;
  workflowBundleSha: string;
  calledWorkflowPath: GitHubActionsStaticWorkflowPath;
  runId: string;
  runAttempt: string;
  eventName: "pull_request" | "push" | "workflow_dispatch";
  eventRef: string;
  defaultBranch: string;
  repositoryVisibility: "public" | "private" | "internal";
  runnerEnvironment: "github-hosted" | "self-hosted";
}

export interface GitHubActionsStaticManifestExpectation {
  repositoryId: string;
  applicationSourceSha: string;
  bindingSourceSha: string;
  defaultBranch: string;
}

export interface GitHubActionsBuildManifestIdentity {
  mode: GitHubActionsBuildManifestMode;
  repositoryId: string;
  fullName: string;
  applicationSourceSha: string;
  eventSourceSha: string;
  workflowBundleSha: string;
  buildProfile: GitHubActionsBuildProfile;
  calledWorkflowPath: (typeof GITHUB_ACTIONS_BUILD_WORKFLOW_PATHS)[GitHubActionsBuildProfile];
  runId: string;
  runAttempt: string;
  eventName: "pull_request" | "push" | "workflow_dispatch";
  eventRef: string;
  releaseRef: string | null;
  releaseTag: string | null;
  defaultBranch: string;
  repositoryVisibility: "private";
  runnerEnvironment: "self-hosted";
}

export interface GitHubActionsBuildManifestExpectation {
  mode: GitHubActionsBuildManifestMode;
  repositoryId: string;
  applicationSourceSha: string;
  eventSourceSha: string;
  workflowBundleSha: string;
  buildProfile: GitHubActionsBuildProfile;
  defaultBranch: string;
  candidateHeadRef: string | null;
  candidatePlanIdentity: string | null;
  releaseRef: string | null;
  releaseTag: string | null;
}

interface GitHubActionsBuildManifestClaims extends GitHubActionsBuildManifestIdentity {
  pullRequestNumber: number | null;
  headRef: string;
  baseRef: string;
}

interface GitHubActionsStaticManifestClaims
  extends Omit<GitHubActionsStaticManifestIdentity, "bindingSourceSha"> {
  requestedBindingSourceSha: string;
  callerWorkflowSha: string;
  pullRequestNumber: number | null;
  headRef: string;
  baseRef: string;
}

export interface GitHubActionsPullRequestReadback {
  number: number;
  state: string;
  baseRepositoryId: string;
  baseRepositoryFullName: string;
  baseRef: string;
  baseSha: string;
  headRepositoryId: string;
  headRepositoryFullName: string;
  headRef: string;
  mergeCommitSha: string;
}

export interface GitHubActionsPullRequestReadInput {
  repositoryId: string;
  fullName: string;
  pullRequestNumber: number;
}

export type GitHubActionsPullRequestReader = (
  input: GitHubActionsPullRequestReadInput,
) => Promise<GitHubActionsPullRequestReadback>;

export type GitHubActionsReleaseTagReader = (
  fullName: string,
  tag: string,
) => Promise<string>;

async function readReleaseTagFromGitHub(fullName: string, tag: string): Promise<string> {
  const { resolveStableTagSha } = await import("@/lib/github/release");
  return resolveStableTagSha(fullName, tag);
}

function unauthorized(): never {
  throw new Error("GITHUB_ACTIONS_OIDC_UNAUTHORIZED");
}

function requiredString(payload: JWTPayload, claim: string): string {
  const value = payload[claim];
  if (typeof value !== "string" || value.length === 0) unauthorized();
  return value;
}

function optionalString(payload: JWTPayload, claim: string): string {
  const value = payload[claim];
  if (value === undefined) return "";
  if (typeof value !== "string") unauthorized();
  return value;
}

export function assertGitHubActionsStaticManifestClaims(
  payload: JWTPayload,
  expectation: GitHubActionsStaticManifestExpectation,
): GitHubActionsStaticManifestClaims {
  const repositoryId = requiredString(payload, "repository_id");
  const fullName = requiredString(payload, "repository");
  const repositoryOwner = requiredString(payload, "repository_owner");
  const repositoryOwnerId = requiredString(payload, "repository_owner_id");
  const applicationSourceSha = requiredString(payload, "sha");
  const callerWorkflowSha = requiredString(payload, "workflow_sha");
  const workflowBundleSha = requiredString(payload, "job_workflow_sha");
  const callerWorkflowRef = requiredString(payload, "workflow_ref");
  const calledWorkflowRef = requiredString(payload, "job_workflow_ref");
  const runId = requiredString(payload, "run_id");
  const runAttempt = requiredString(payload, "run_attempt");
  const eventName = requiredString(payload, "event_name");
  const eventRef = requiredString(payload, "ref");
  const repositoryVisibility = requiredString(payload, "repository_visibility");
  const runnerEnvironment = requiredString(payload, "runner_environment");
  const headRef = optionalString(payload, "head_ref");
  const baseRef = optionalString(payload, "base_ref");
  const calledWorkflowPath = Object.values(GITHUB_ACTIONS_STATIC_WORKFLOW_PATHS).find(
    (path) => calledWorkflowRef === `seorilabs/.github/${path}@${workflowBundleSha}`,
  );
  const defaultBranch = expectation.defaultBranch;
  const defaultBranchRef = repositoryDefaultBranchRef(defaultBranch);

  if (
    repositoryId !== expectation.repositoryId
    || !POSITIVE_INTEGER.test(repositoryId)
    || !REPOSITORY.test(fullName)
    || repositoryOwner !== "seorilabs"
    || repositoryOwnerId !== SEORILABS_ORGANIZATION_ID
    || applicationSourceSha !== expectation.applicationSourceSha
    || !SHA.test(applicationSourceSha)
    || !SHA.test(expectation.bindingSourceSha)
    || !SHA.test(callerWorkflowSha)
    || !SHA.test(workflowBundleSha)
    || !POSITIVE_INTEGER.test(runId)
    || !POSITIVE_INTEGER.test(runAttempt)
    || !["public", "private", "internal"].includes(repositoryVisibility)
    || !["github-hosted", "self-hosted"].includes(runnerEnvironment)
    || !calledWorkflowPath
    || !defaultBranchRef
    || callerWorkflowRef !== `${fullName}/${STATIC_CALLER_PATH}@${eventRef}`
  ) {
    unauthorized();
  }

  let pullRequestNumber: number | null = null;
  if (eventName === "pull_request") {
    const match = /^refs\/pull\/([1-9][0-9]*)\/merge$/.exec(eventRef);
    if (
      !match
      || baseRef !== defaultBranch
      || headRef.length === 0
      || callerWorkflowSha !== applicationSourceSha
    ) {
      unauthorized();
    }
    pullRequestNumber = Number(match[1]);
    if (!Number.isSafeInteger(pullRequestNumber)) unauthorized();
  } else if (eventName === "push" || eventName === "workflow_dispatch") {
    if (
      eventRef !== defaultBranchRef
      || callerWorkflowSha !== applicationSourceSha
      || expectation.bindingSourceSha !== applicationSourceSha
      || headRef !== ""
      || baseRef !== ""
    ) {
      unauthorized();
    }
  } else {
    unauthorized();
  }

  return {
    repositoryId,
    fullName,
    applicationSourceSha,
    requestedBindingSourceSha: expectation.bindingSourceSha,
    callerWorkflowSha,
    workflowBundleSha,
    calledWorkflowPath,
    runId,
    runAttempt,
    eventName,
    eventRef,
    defaultBranch,
    repositoryVisibility: repositoryVisibility as GitHubActionsStaticManifestIdentity["repositoryVisibility"],
    runnerEnvironment: runnerEnvironment as GitHubActionsStaticManifestIdentity["runnerEnvironment"],
    pullRequestNumber,
    headRef,
    baseRef,
  };
}

export function assertGitHubActionsBuildManifestClaims(
  payload: JWTPayload,
  expectation: GitHubActionsBuildManifestExpectation,
): GitHubActionsBuildManifestClaims {
  const repositoryId = requiredString(payload, "repository_id");
  const fullName = requiredString(payload, "repository");
  const repositoryOwner = requiredString(payload, "repository_owner");
  const repositoryOwnerId = requiredString(payload, "repository_owner_id");
  const eventSourceSha = requiredString(payload, "sha");
  const callerWorkflowSha = requiredString(payload, "workflow_sha");
  const workflowBundleSha = requiredString(payload, "job_workflow_sha");
  const callerWorkflowRef = requiredString(payload, "workflow_ref");
  const calledWorkflowRef = requiredString(payload, "job_workflow_ref");
  const runId = requiredString(payload, "run_id");
  const runAttempt = requiredString(payload, "run_attempt");
  const eventName = requiredString(payload, "event_name");
  const eventRef = requiredString(payload, "ref");
  const repositoryVisibility = requiredString(payload, "repository_visibility");
  const runnerEnvironment = requiredString(payload, "runner_environment");
  const headRef = optionalString(payload, "head_ref");
  const baseRef = optionalString(payload, "base_ref");
  const calledWorkflowPath = GITHUB_ACTIONS_BUILD_WORKFLOW_PATHS[expectation.buildProfile];
  const defaultBranch = expectation.defaultBranch;
  const defaultBranchRef = repositoryDefaultBranchRef(defaultBranch);

  if (
    repositoryId !== expectation.repositoryId
    || !POSITIVE_INTEGER.test(repositoryId)
    || !REPOSITORY.test(fullName)
    || repositoryOwner !== "seorilabs"
    || repositoryOwnerId !== SEORILABS_ORGANIZATION_ID
    || !SHA.test(expectation.applicationSourceSha)
    || eventSourceSha !== expectation.eventSourceSha
    || !SHA.test(eventSourceSha)
    || workflowBundleSha !== expectation.workflowBundleSha
    || !SHA.test(workflowBundleSha)
    || !POSITIVE_INTEGER.test(runId)
    || !POSITIVE_INTEGER.test(runAttempt)
    || repositoryVisibility !== "private"
    || runnerEnvironment !== "self-hosted"
    || calledWorkflowRef !== `seorilabs/.github/${calledWorkflowPath}@${workflowBundleSha}`
    || callerWorkflowRef !== `${fullName}/${BUILD_CALLER_PATH}@${eventRef}`
    || !defaultBranchRef
  ) {
    unauthorized();
  }

  let pullRequestNumber: number | null = null;
  if (expectation.mode === "APPROVED") {
    if (
      expectation.candidateHeadRef !== null
      || expectation.candidatePlanIdentity !== null
      || expectation.releaseRef !== null
      || expectation.releaseTag !== null
      || eventName !== "workflow_dispatch"
      || eventRef !== defaultBranchRef
      || expectation.applicationSourceSha !== eventSourceSha
      || callerWorkflowSha !== eventSourceSha
      || headRef !== ""
      || baseRef !== ""
    ) {
      unauthorized();
    }
  } else if (expectation.mode === "CANDIDATE") {
    const canary = GITHUB_ACTIONS_BUILD_CANARIES[repositoryId as keyof typeof GITHUB_ACTIONS_BUILD_CANARIES];
    const match = /^refs\/pull\/([1-9][0-9]*)\/merge$/.exec(eventRef);
    const candidateHead = expectation.candidateHeadRef === null
      ? null
      : /^seori\/workflow-bundle-v5-canary\/([1-9][0-9]{0,31})\/([0-9a-f]{12})\/([0-9a-f]{64})$/u.exec(expectation.candidateHeadRef);
    if (
      eventName !== "pull_request"
      || !canary
      || canary.fullName !== fullName
      || canary.buildProfile !== expectation.buildProfile
      || !match
      || baseRef !== defaultBranch
      || headRef !== expectation.candidateHeadRef
      || candidateHead?.[1] !== repositoryId
      || candidateHead?.[2] !== workflowBundleSha.slice(0, 12)
      || candidateHead?.[3] !== expectation.candidatePlanIdentity
      || !PLAN_IDENTITY.test(expectation.candidatePlanIdentity ?? "")
      || expectation.releaseRef !== null
      || expectation.releaseTag !== null
      || callerWorkflowSha !== eventSourceSha
      || expectation.applicationSourceSha === eventSourceSha
    ) {
      unauthorized();
    }
    pullRequestNumber = Number(match[1]);
    if (!Number.isSafeInteger(pullRequestNumber)) unauthorized();
  } else {
    const expectedReleaseRef = expectation.releaseTag === null
      ? null
      : `refs/tags/${expectation.releaseTag}`;
    if (
      expectation.candidateHeadRef !== null
      || expectation.candidatePlanIdentity !== null
      || expectation.releaseRef === null
      || expectation.releaseTag === null
      || !STABLE_RELEASE_TAG.test(expectation.releaseTag)
      || expectation.releaseRef !== expectedReleaseRef
      || eventRef !== expectation.releaseRef
      || !["push", "workflow_dispatch"].includes(eventName)
      || callerWorkflowSha !== expectation.applicationSourceSha
      || headRef !== ""
      || baseRef !== ""
    ) {
      unauthorized();
    }
  }

  return {
    mode: expectation.mode,
    repositoryId,
    fullName,
    applicationSourceSha: expectation.applicationSourceSha,
    eventSourceSha,
    workflowBundleSha,
    buildProfile: expectation.buildProfile,
    calledWorkflowPath,
    runId,
    runAttempt,
    eventName: eventName as GitHubActionsBuildManifestIdentity["eventName"],
    eventRef,
    releaseRef: expectation.releaseRef,
    releaseTag: expectation.releaseTag,
    defaultBranch,
    repositoryVisibility: "private",
    runnerEnvironment: "self-hosted",
    pullRequestNumber,
    headRef,
    baseRef,
  };
}

async function readPullRequestFromGitHub(
  input: GitHubActionsPullRequestReadInput,
): Promise<GitHubActionsPullRequestReadback> {
  const [owner, repo, extra] = input.fullName.split("/");
  if (!owner || !repo || extra !== undefined) unauthorized();
  const { getInstallationOctokit } = await import("@/lib/github/app");
  const client = await getInstallationOctokit();
  const response = await client.rest.pulls.get({
    owner,
    repo,
    pull_number: input.pullRequestNumber,
  });
  return {
    number: response.data.number,
    state: response.data.state,
    baseRepositoryId: String(response.data.base.repo?.id ?? ""),
    baseRepositoryFullName: response.data.base.repo?.full_name ?? "",
    baseRef: response.data.base.ref,
    baseSha: response.data.base.sha.toLowerCase(),
    headRepositoryId: String(response.data.head.repo?.id ?? ""),
    headRepositoryFullName: response.data.head.repo?.full_name ?? "",
    headRef: response.data.head.ref,
    mergeCommitSha: response.data.merge_commit_sha?.toLowerCase() ?? "",
  };
}

function bindStaticManifestIdentity(
  claims: GitHubActionsStaticManifestClaims,
): GitHubActionsStaticManifestIdentity {
  return {
    repositoryId: claims.repositoryId,
    fullName: claims.fullName,
    applicationSourceSha: claims.applicationSourceSha,
    bindingSourceSha: claims.requestedBindingSourceSha,
    workflowBundleSha: claims.workflowBundleSha,
    calledWorkflowPath: claims.calledWorkflowPath,
    runId: claims.runId,
    runAttempt: claims.runAttempt,
    eventName: claims.eventName,
    eventRef: claims.eventRef,
    defaultBranch: claims.defaultBranch,
    repositoryVisibility: claims.repositoryVisibility,
    runnerEnvironment: claims.runnerEnvironment,
  };
}

function bindBuildManifestIdentity(
  claims: GitHubActionsBuildManifestClaims,
): GitHubActionsBuildManifestIdentity {
  return {
    mode: claims.mode,
    repositoryId: claims.repositoryId,
    fullName: claims.fullName,
    applicationSourceSha: claims.applicationSourceSha,
    eventSourceSha: claims.eventSourceSha,
    workflowBundleSha: claims.workflowBundleSha,
    buildProfile: claims.buildProfile,
    calledWorkflowPath: claims.calledWorkflowPath,
    runId: claims.runId,
    runAttempt: claims.runAttempt,
    eventName: claims.eventName,
    eventRef: claims.eventRef,
    releaseRef: claims.releaseRef,
    releaseTag: claims.releaseTag,
    defaultBranch: claims.defaultBranch,
    repositoryVisibility: claims.repositoryVisibility,
    runnerEnvironment: claims.runnerEnvironment,
  };
}

function pullRequestReadbackMatches(
  claims: GitHubActionsStaticManifestClaims,
  readback: GitHubActionsPullRequestReadback,
): boolean {
  return claims.pullRequestNumber !== null
    && readback.number === claims.pullRequestNumber
    && readback.state === "open"
    && readback.baseRepositoryId === claims.repositoryId
    && readback.baseRepositoryFullName === claims.fullName
    && readback.baseRef === claims.baseRef
    && readback.baseSha === claims.requestedBindingSourceSha
    && readback.headRepositoryId === claims.repositoryId
    && readback.headRepositoryFullName === claims.fullName
    && readback.headRef === claims.headRef
    && readback.mergeCommitSha === claims.applicationSourceSha;
}

function buildPullRequestReadbackMatches(
  claims: GitHubActionsBuildManifestClaims,
  readback: GitHubActionsPullRequestReadback,
): boolean {
  return claims.mode === "CANDIDATE"
    && claims.pullRequestNumber !== null
    && readback.number === claims.pullRequestNumber
    && readback.state === "open"
    && readback.baseRepositoryId === claims.repositoryId
    && readback.baseRepositoryFullName === claims.fullName
    && readback.baseRef === claims.defaultBranch
    && readback.baseSha === claims.applicationSourceSha
    && readback.headRepositoryId === claims.repositoryId
    && readback.headRepositoryFullName === claims.fullName
    && readback.headRef === claims.headRef
    && readback.mergeCommitSha === claims.eventSourceSha;
}

export async function verifyGitHubActionsOidcToken(
  token: string,
  key: JWTVerifyGetKey = GITHUB_ACTIONS_JWKS,
) {
  return jwtVerify(token, key, {
    algorithms: ["RS256"],
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: GITHUB_ACTIONS_AUDIENCE,
    requiredClaims: [
      "jti",
      "iat",
      "nbf",
      "exp",
      "repository",
      "repository_id",
      "repository_owner",
      "repository_owner_id",
      "sha",
      "ref",
      "workflow_ref",
      "workflow_sha",
      "job_workflow_ref",
      "job_workflow_sha",
      "run_id",
      "run_attempt",
      "event_name",
      "repository_visibility",
      "runner_environment",
    ],
    clockTolerance: 5,
  });
}

const defaultVerifier: GitHubActionsOidcVerifier = (token) => verifyGitHubActionsOidcToken(token);

export async function authenticateGitHubActionsStaticManifestRequest(
  request: NextRequest,
  expectation: GitHubActionsStaticManifestExpectation,
  verifier: GitHubActionsOidcVerifier = defaultVerifier,
  readPullRequest: GitHubActionsPullRequestReader = readPullRequestFromGitHub,
): Promise<GitHubActionsStaticManifestIdentity | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (token.length > 16 * 1024 || !JWT.test(token)) return null;
  try {
    const { payload, protectedHeader } = await verifier(token);
    if (protectedHeader.alg !== "RS256" || protectedHeader.typ !== "JWT") return null;
    const claims = assertGitHubActionsStaticManifestClaims(payload, expectation);
    if (
      request.headers.get("x-seori-principal")
      !== `github-actions:${claims.repositoryId}:${claims.runId}`
    ) {
      return null;
    }
    if (claims.eventName === "pull_request") {
      if (claims.pullRequestNumber === null) return null;
      const readback = await readPullRequest({
        repositoryId: claims.repositoryId,
        fullName: claims.fullName,
        pullRequestNumber: claims.pullRequestNumber,
      });
      if (!pullRequestReadbackMatches(claims, readback)) return null;
    }
    return bindStaticManifestIdentity(claims);
  } catch {
    return null;
  }
}

export async function authenticateGitHubActionsBuildManifestRequest(
  request: NextRequest,
  expectation: GitHubActionsBuildManifestExpectation,
  verifier: GitHubActionsOidcVerifier = defaultVerifier,
  readPullRequest: GitHubActionsPullRequestReader = readPullRequestFromGitHub,
  readReleaseTag: GitHubActionsReleaseTagReader = readReleaseTagFromGitHub,
): Promise<GitHubActionsBuildManifestIdentity | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (token.length > 16 * 1024 || !JWT.test(token)) return null;
  try {
    const { payload, protectedHeader } = await verifier(token);
    if (protectedHeader.alg !== "RS256" || protectedHeader.typ !== "JWT") return null;
    const claims = assertGitHubActionsBuildManifestClaims(payload, expectation);
    if (
      request.headers.get("x-seori-principal")
      !== `github-actions:${claims.repositoryId}:${claims.runId}`
    ) {
      return null;
    }
    if (claims.mode === "CANDIDATE") {
      if (claims.pullRequestNumber === null) return null;
      const readback = await readPullRequest({
        repositoryId: claims.repositoryId,
        fullName: claims.fullName,
        pullRequestNumber: claims.pullRequestNumber,
      });
      if (!buildPullRequestReadbackMatches(claims, readback)) return null;
    } else if (claims.mode === "RELEASE") {
      if (
        claims.releaseTag === null
        || await readReleaseTag(claims.fullName, claims.releaseTag)
          !== claims.applicationSourceSha
      ) {
        return null;
      }
    }
    return bindBuildManifestIdentity(claims);
  } catch {
    return null;
  }
}
