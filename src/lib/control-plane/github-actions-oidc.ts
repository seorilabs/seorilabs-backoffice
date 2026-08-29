import type { NextRequest } from "next/server";
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
const STATIC_REUSABLE_WORKFLOW_PATH = ".github/workflows/js-static-checks-v1.yml";
const SHA = /^[0-9a-f]{40}$/;
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
  runId: string;
  runAttempt: string;
  eventName: "pull_request" | "push" | "workflow_dispatch";
  eventRef: string;
  repositoryVisibility: "public" | "private" | "internal";
  runnerEnvironment: "github-hosted" | "self-hosted";
}

export interface GitHubActionsStaticManifestExpectation {
  repositoryId: string;
  applicationSourceSha: string;
  bindingSourceSha: string;
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
): GitHubActionsStaticManifestIdentity {
  const repositoryId = requiredString(payload, "repository_id");
  const fullName = requiredString(payload, "repository");
  const repositoryOwner = requiredString(payload, "repository_owner");
  const repositoryOwnerId = requiredString(payload, "repository_owner_id");
  const applicationSourceSha = requiredString(payload, "sha");
  const bindingSourceSha = requiredString(payload, "workflow_sha");
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

  if (
    repositoryId !== expectation.repositoryId
    || !POSITIVE_INTEGER.test(repositoryId)
    || !REPOSITORY.test(fullName)
    || repositoryOwner !== "seorilabs"
    || repositoryOwnerId !== SEORILABS_ORGANIZATION_ID
    || applicationSourceSha !== expectation.applicationSourceSha
    || bindingSourceSha !== expectation.bindingSourceSha
    || !SHA.test(applicationSourceSha)
    || !SHA.test(bindingSourceSha)
    || !SHA.test(workflowBundleSha)
    || !POSITIVE_INTEGER.test(runId)
    || !POSITIVE_INTEGER.test(runAttempt)
    || !["public", "private", "internal"].includes(repositoryVisibility)
    || !["github-hosted", "self-hosted"].includes(runnerEnvironment)
    || calledWorkflowRef !== `seorilabs/.github/${STATIC_REUSABLE_WORKFLOW_PATH}@${workflowBundleSha}`
    || callerWorkflowRef !== `${fullName}/${STATIC_CALLER_PATH}@${eventRef}`
  ) {
    unauthorized();
  }

  if (eventName === "pull_request") {
    if (
      !/^refs\/pull\/[1-9][0-9]*\/merge$/.test(eventRef)
      || baseRef !== "main"
      || headRef.length === 0
    ) {
      unauthorized();
    }
  } else if (eventName === "push" || eventName === "workflow_dispatch") {
    if (
      eventRef !== "refs/heads/main"
      || bindingSourceSha !== applicationSourceSha
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
    bindingSourceSha,
    workflowBundleSha,
    runId,
    runAttempt,
    eventName,
    eventRef,
    repositoryVisibility: repositoryVisibility as GitHubActionsStaticManifestIdentity["repositoryVisibility"],
    runnerEnvironment: runnerEnvironment as GitHubActionsStaticManifestIdentity["runnerEnvironment"],
  };
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
): Promise<GitHubActionsStaticManifestIdentity | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (token.length > 16 * 1024 || !JWT.test(token)) return null;
  try {
    const { payload, protectedHeader } = await verifier(token);
    if (protectedHeader.alg !== "RS256" || protectedHeader.typ !== "JWT") return null;
    const identity = assertGitHubActionsStaticManifestClaims(payload, expectation);
    if (
      request.headers.get("x-seori-principal")
      !== `github-actions:${identity.repositoryId}:${identity.runId}`
    ) {
      return null;
    }
    return identity;
  } catch {
    return null;
  }
}
