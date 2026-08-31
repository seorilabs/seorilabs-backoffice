import type { NextRequest } from "next/server";
import type { JWTPayload } from "jose";

import {
  verifyGitHubActionsOidcToken,
  type GitHubActionsOidcVerifier,
} from "@/lib/control-plane/github-actions-oidc";
import { withFleetScopedGithubClient } from "@/lib/github/scoped-installation-client";

export const FLEET_CLEANUP_EXECUTOR_REPOSITORY_ID = "1241442018";
export const FLEET_CLEANUP_EXECUTOR_REPOSITORY = "seorilabs/.github";
export const FLEET_CLEANUP_EXECUTOR_REF = "refs/heads/main";
export const FLEET_CLEANUP_CALLER_WORKFLOW = ".github/workflows/fleet-cleanup-reconciler.yml";
export const FLEET_CLEANUP_CALLED_WORKFLOW = ".github/workflows/fleet-cleanup-executor-v1.yml";

const ORGANIZATION_ID = "283115031";
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

export interface FleetCleanupGithubActionsIdentity {
  repositoryId: typeof FLEET_CLEANUP_EXECUTOR_REPOSITORY_ID;
  runId: string;
  runAttempt: string;
  workflowSha: string;
}

export type FleetCleanupWorkflowHeadReader = () => Promise<string>;

function requiredString(payload: JWTPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new Error("FLEET_CLEANUP_OIDC_UNAUTHORIZED");
  return value;
}

async function readExecutorWorkflowHead(): Promise<string> {
  const { getFleetScopedGithubTokenIssuer } = await import("@/lib/github/app");
  const scoped = await getFleetScopedGithubTokenIssuer();
  return withFleetScopedGithubClient({
    ...scoped,
    capability: "github.fleet-cleanup.executor-identity.read",
    repositoryId: FLEET_CLEANUP_EXECUTOR_REPOSITORY_ID,
    repositoryFullName: FLEET_CLEANUP_EXECUTOR_REPOSITORY,
    execute: async (client) => {
      const [repository, branch] = await Promise.all([
        client.rest.repos.get({ owner: "seorilabs", repo: ".github" }),
        client.rest.repos.getBranch({ owner: "seorilabs", repo: ".github", branch: "main" }),
      ]);
      const sha = branch.data.commit.sha.toLowerCase();
      if (
        String(repository.data.id) !== FLEET_CLEANUP_EXECUTOR_REPOSITORY_ID
        || repository.data.full_name !== FLEET_CLEANUP_EXECUTOR_REPOSITORY
        || repository.data.default_branch !== "main"
        || repository.data.visibility !== "public"
        || !SHA.test(sha)
      ) throw new Error("FLEET_CLEANUP_EXECUTOR_WORKFLOW_READBACK_MISMATCH");
      return sha;
    },
  });
}

const defaultVerifier: GitHubActionsOidcVerifier = (token) => verifyGitHubActionsOidcToken(token);

export async function authenticateFleetCleanupGithubActionsRequest(input: {
  request: NextRequest;
  expectedRunId: string;
  expectedRunAttempt: string;
  verifier?: GitHubActionsOidcVerifier;
  readWorkflowHead?: FleetCleanupWorkflowHeadReader;
}): Promise<FleetCleanupGithubActionsIdentity | null> {
  const authorization = input.request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (
    token.length > 16 * 1024
    || !JWT.test(token)
    || !POSITIVE_INTEGER.test(input.expectedRunId)
    || !POSITIVE_INTEGER.test(input.expectedRunAttempt)
  ) return null;
  try {
    const { payload, protectedHeader } = await (input.verifier ?? defaultVerifier)(token);
    if (protectedHeader.alg !== "RS256" || protectedHeader.typ !== "JWT") return null;
    const workflowSha = await (input.readWorkflowHead ?? readExecutorWorkflowHead)();
    const runId = requiredString(payload, "run_id");
    const runAttempt = requiredString(payload, "run_attempt");
    if (
      !SHA.test(workflowSha)
      || payload.iss !== "https://token.actions.githubusercontent.com"
      || payload.aud !== "seorilabs-control-plane"
      || requiredString(payload, "sub") !== `repo:${FLEET_CLEANUP_EXECUTOR_REPOSITORY}:ref:${FLEET_CLEANUP_EXECUTOR_REF}`
      || requiredString(payload, "repository") !== FLEET_CLEANUP_EXECUTOR_REPOSITORY
      || requiredString(payload, "repository_id") !== FLEET_CLEANUP_EXECUTOR_REPOSITORY_ID
      || requiredString(payload, "repository_owner") !== "seorilabs"
      || requiredString(payload, "repository_owner_id") !== ORGANIZATION_ID
      || requiredString(payload, "sha") !== workflowSha
      || requiredString(payload, "ref") !== FLEET_CLEANUP_EXECUTOR_REF
      || requiredString(payload, "workflow_ref") !== `${FLEET_CLEANUP_EXECUTOR_REPOSITORY}/${FLEET_CLEANUP_CALLER_WORKFLOW}@${FLEET_CLEANUP_EXECUTOR_REF}`
      || requiredString(payload, "workflow_sha") !== workflowSha
      || requiredString(payload, "job_workflow_ref") !== `${FLEET_CLEANUP_EXECUTOR_REPOSITORY}/${FLEET_CLEANUP_CALLED_WORKFLOW}@${FLEET_CLEANUP_EXECUTOR_REF}`
      || requiredString(payload, "job_workflow_sha") !== workflowSha
      || runId !== input.expectedRunId
      || runAttempt !== input.expectedRunAttempt
      || requiredString(payload, "event_name") !== "workflow_dispatch"
      || requiredString(payload, "repository_visibility") !== "public"
      || requiredString(payload, "runner_environment") !== "github-hosted"
      || (payload.head_ref ?? "") !== ""
      || (payload.base_ref ?? "") !== ""
    ) return null;
    return {
      repositoryId: FLEET_CLEANUP_EXECUTOR_REPOSITORY_ID,
      runId,
      runAttempt,
      workflowSha,
    };
  } catch {
    return null;
  }
}
