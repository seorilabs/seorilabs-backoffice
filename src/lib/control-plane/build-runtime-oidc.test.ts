import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import type { JWTPayload } from "jose";

import {
  assertGitHubActionsBuildManifestClaims,
  authenticateGitHubActionsBuildManifestRequest,
} from "@/lib/control-plane/github-actions-oidc";

const EVENT_SHA = "a".repeat(40);
const APPLICATION_SHA = "b".repeat(40);
const BUNDLE_SHA = "c".repeat(40);
const REPOSITORY_ID = "1250442131";
const FULL_NAME = "seorilabs/happy-farm";
const HEAD_REF = `seori/workflow-bundle-v5-canary/${REPOSITORY_ID}/${BUNDLE_SHA.slice(0, 12)}`;

function candidateClaims(overrides: Partial<JWTPayload> = {}): JWTPayload {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "seorilabs-control-plane",
    sub: `repo:${FULL_NAME}:pull_request`,
    jti: "build-oidc-jti",
    iat: 1,
    nbf: 1,
    exp: 9_999_999_999,
    repository: FULL_NAME,
    repository_id: REPOSITORY_ID,
    repository_owner: "seorilabs",
    repository_owner_id: "283115031",
    sha: EVENT_SHA,
    ref: "refs/pull/91/merge",
    workflow_ref: `${FULL_NAME}/.github/workflows/android-build-only.yml@refs/pull/91/merge`,
    workflow_sha: EVENT_SHA,
    job_workflow_ref: `seorilabs/.github/.github/workflows/rn-build-android-cloud-v2.yml@${BUNDLE_SHA}`,
    job_workflow_sha: BUNDLE_SHA,
    run_id: "1234",
    run_attempt: "1",
    event_name: "pull_request",
    head_ref: HEAD_REF,
    base_ref: "main",
    repository_visibility: "private",
    runner_environment: "self-hosted",
    ...overrides,
  };
}

const candidateExpectation = {
  mode: "CANDIDATE" as const,
  repositoryId: REPOSITORY_ID,
  applicationSourceSha: APPLICATION_SHA,
  eventSourceSha: EVENT_SHA,
  workflowBundleSha: BUNDLE_SHA,
  buildProfile: "react-native-android" as const,
  defaultBranch: "main",
};

test("build canary OIDC는 고정 repo/profile/head와 exact central SHA에 결합된다", () => {
  const identity = assertGitHubActionsBuildManifestClaims(candidateClaims(), candidateExpectation);
  assert.equal(identity.mode, "CANDIDATE");
  assert.equal(identity.applicationSourceSha, APPLICATION_SHA);
  assert.equal(identity.eventSourceSha, EVENT_SHA);
  assert.equal(identity.calledWorkflowPath, ".github/workflows/rn-build-android-cloud-v2.yml");
  assert.equal(identity.pullRequestNumber, 91);
});

test("일반 APPROVED build는 registered default branch workflow_dispatch와 동일 source만 허용한다", () => {
  const payload = candidateClaims({
    sha: APPLICATION_SHA,
    ref: "refs/heads/main",
    workflow_ref: `${FULL_NAME}/.github/workflows/android-build-only.yml@refs/heads/main`,
    workflow_sha: APPLICATION_SHA,
    event_name: "workflow_dispatch",
    head_ref: "",
    base_ref: "",
  });
  const identity = assertGitHubActionsBuildManifestClaims(payload, {
    ...candidateExpectation,
    mode: "APPROVED",
    eventSourceSha: APPLICATION_SHA,
  });
  assert.equal(identity.mode, "APPROVED");
  assert.equal(identity.applicationSourceSha, identity.eventSourceSha);
  assert.equal(identity.pullRequestNumber, null);
});

test("일반 APPROVED build는 등록된 non-main default branch도 exact ref로 결합한다", () => {
  const payload = candidateClaims({
    sha: APPLICATION_SHA,
    ref: "refs/heads/develop",
    workflow_ref: `${FULL_NAME}/.github/workflows/android-build-only.yml@refs/heads/develop`,
    workflow_sha: APPLICATION_SHA,
    event_name: "workflow_dispatch",
    head_ref: "",
    base_ref: "",
  });
  const identity = assertGitHubActionsBuildManifestClaims(payload, {
    ...candidateExpectation,
    mode: "APPROVED",
    eventSourceSha: APPLICATION_SHA,
    defaultBranch: "develop",
  });
  assert.equal(identity.defaultBranch, "develop");
  assert.equal(identity.eventRef, "refs/heads/develop");
});

test("candidate alias, public runner, 임의 branch와 profile 교차 대체를 거부한다", () => {
  for (const [payload, expectation] of [
    [candidateClaims({ repository_id: "1265192029" }), candidateExpectation],
    [candidateClaims({ repository_visibility: "public", runner_environment: "github-hosted" }), candidateExpectation],
    [candidateClaims({ head_ref: "feature/untrusted" }), candidateExpectation],
    [candidateClaims(), { ...candidateExpectation, buildProfile: "godot-android" as const }],
    [candidateClaims({ job_workflow_sha: "d".repeat(40) }), candidateExpectation],
  ] as const) {
    assert.throws(
      () => assertGitHubActionsBuildManifestClaims(payload, expectation),
      /GITHUB_ACTIONS_OIDC_UNAUTHORIZED/,
    );
  }
});

test("candidate identity는 GitHub App exact base/merge/head readback 뒤에만 발급된다", async () => {
  const request = new NextRequest("https://backoffice.vzyx.xyz/runtime", {
    headers: {
      authorization: "Bearer a.b.c",
      "x-seori-principal": `github-actions:${REPOSITORY_ID}:1234`,
    },
  });
  const verifier = async () => ({
    payload: candidateClaims(),
    protectedHeader: { alg: "RS256", typ: "JWT" },
  });
  const exact = {
    number: 91,
    state: "open",
    baseRepositoryId: REPOSITORY_ID,
    baseRepositoryFullName: FULL_NAME,
    baseRef: "main",
    baseSha: APPLICATION_SHA,
    headRepositoryId: REPOSITORY_ID,
    headRepositoryFullName: FULL_NAME,
    headRef: HEAD_REF,
    mergeCommitSha: EVENT_SHA,
  };
  assert.ok(await authenticateGitHubActionsBuildManifestRequest(
    request,
    candidateExpectation,
    verifier,
    async () => exact,
  ));
  for (const readback of [
    { ...exact, baseSha: "e".repeat(40) },
    { ...exact, mergeCommitSha: "e".repeat(40) },
    { ...exact, headRepositoryFullName: "attacker/happy-farm" },
    { ...exact, headRef: "feature/untrusted" },
    { ...exact, state: "closed" },
  ]) {
    assert.equal(await authenticateGitHubActionsBuildManifestRequest(
      request,
      candidateExpectation,
      verifier,
      async () => readback,
    ), null);
  }
});
