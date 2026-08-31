import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";
import type { JWTPayload } from "jose";

import { authenticateFleetCleanupGithubActionsRequest } from "@/lib/control-plane/fleet-cleanup-github-actions-oidc";
import { fleetCleanupCapabilityRequestSchema } from "@/lib/control-plane/fleet-cleanup-capability-contract";

const WORKFLOW_SHA = "a".repeat(40);
const RUN_ID = "12345678901";
const RUN_ATTEMPT = "2";

function claims(overrides: Partial<JWTPayload> = {}): JWTPayload {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "seorilabs-control-plane",
    sub: "repo:seorilabs/.github:ref:refs/heads/main",
    jti: "fleet-cleanup-oidc-jti-1",
    iat: 1,
    nbf: 1,
    exp: 9_999_999_999,
    repository: "seorilabs/.github",
    repository_id: "1241442018",
    repository_owner: "seorilabs",
    repository_owner_id: "283115031",
    sha: WORKFLOW_SHA,
    ref: "refs/heads/main",
    workflow_ref: "seorilabs/.github/.github/workflows/fleet-cleanup-reconciler.yml@refs/heads/main",
    workflow_sha: WORKFLOW_SHA,
    job_workflow_ref: "seorilabs/.github/.github/workflows/fleet-cleanup-executor-v1.yml@refs/heads/main",
    job_workflow_sha: WORKFLOW_SHA,
    run_id: RUN_ID,
    run_attempt: RUN_ATTEMPT,
    event_name: "workflow_dispatch",
    head_ref: "",
    base_ref: "",
    repository_visibility: "public",
    runner_environment: "github-hosted",
    ...overrides,
  };
}

function request(runId = RUN_ID, runAttempt = RUN_ATTEMPT) {
  return new NextRequest("https://backoffice.example/api/internal/fleet-migration/cleanup-capabilities", {
    method: "POST",
    headers: {
      authorization: "Bearer header.payload.signature",
      "x-seori-principal": `github-actions:1241442018:${runId}:${runAttempt}`,
    },
  });
}

async function authenticate(payload: JWTPayload, runId = RUN_ID, runAttempt = RUN_ATTEMPT) {
  return authenticateFleetCleanupGithubActionsRequest({
    request: request(runId, runAttempt),
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
    verifier: async () => ({ payload, protectedHeader: { alg: "RS256", typ: "JWT" } }),
    readWorkflowHead: async () => WORKFLOW_SHA,
  });
}

test("cleanup executor OIDC는 public .github main의 caller/called/live SHA/run attempt에 결합된다", async () => {
  assert.deepEqual(await authenticate(claims()), {
    repositoryId: "1241442018",
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    workflowSha: WORKFLOW_SHA,
  });
});

test("fork/ref/path/SHA/runner/visibility/event/audience/run drift는 모두 거부한다", async () => {
  const invalid: JWTPayload[] = [
    claims({ repository: "someone/.github" }),
    claims({ ref: "refs/heads/feature" }),
    claims({ workflow_ref: "seorilabs/.github/.github/workflows/other.yml@refs/heads/main" }),
    claims({ job_workflow_ref: "seorilabs/.github/.github/workflows/other.yml@refs/heads/main" }),
    claims({ workflow_sha: "b".repeat(40) }),
    claims({ job_workflow_sha: "b".repeat(40) }),
    claims({ runner_environment: "self-hosted" }),
    claims({ repository_visibility: "private" }),
    claims({ event_name: "push" }),
    claims({ aud: "different-audience" }),
    claims({ run_id: "99999999999" }),
    claims({ run_attempt: "3" }),
  ];
  for (const payload of invalid) assert.equal(await authenticate(payload), null);
});

test("body run binding이나 principal이 OIDC와 다르면 거부한다", async () => {
  assert.equal(await authenticate(claims(), "99999999999", RUN_ATTEMPT), null);
  const mismatchedPrincipal = request();
  mismatchedPrincipal.headers.set("x-seori-principal", "github-actions:1241442018:1:1");
  assert.equal(await authenticateFleetCleanupGithubActionsRequest({
    request: mismatchedPrincipal,
    expectedRunId: RUN_ID,
    expectedRunAttempt: RUN_ATTEMPT,
    verifier: async () => ({ payload: claims(), protectedHeader: { alg: "RS256", typ: "JWT" } }),
    readWorkflowHead: async () => WORKFLOW_SHA,
  }), null);
});

test("EXECUTE body는 capability/scope/run binding만 받고 target identity 주장을 거부한다", () => {
  const body = {
    operation: "EXECUTE",
    capabilityId: "fleet-cleanup-capability-0001",
    approvalScopeDigest: `sha256:${"b".repeat(64)}`,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
  };
  assert.deepEqual(fleetCleanupCapabilityRequestSchema.parse(body), body);
  assert.equal(fleetCleanupCapabilityRequestSchema.safeParse({
    ...body,
    repositoryId: "1250442131",
  }).success, false);
  assert.equal(fleetCleanupCapabilityRequestSchema.safeParse({
    operation: "EXECUTE",
    capabilityId: body.capabilityId,
    request: { runId: RUN_ID, runAttempt: RUN_ATTEMPT },
  }).success, false);
});
