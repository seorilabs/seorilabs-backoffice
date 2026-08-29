import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import {
  assertGitHubActionsStaticManifestClaims,
  authenticateGitHubActionsStaticManifestRequest,
  verifyGitHubActionsOidcToken,
} from "@/lib/control-plane/github-actions-oidc";

const APPLICATION_SHA = "a".repeat(40);
const BINDING_SHA = "b".repeat(40);
const BUNDLE_SHA = "c".repeat(40);

function claims(overrides: Partial<JWTPayload> = {}): JWTPayload {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "seorilabs-control-plane",
    sub: "repo:seorilabs/runtime-canary:ref:refs/heads/main",
    jti: "oidc-jti-1",
    iat: 1,
    nbf: 1,
    exp: 9_999_999_999,
    repository: "seorilabs/runtime-canary",
    repository_id: "7001",
    repository_owner: "seorilabs",
    repository_owner_id: "283115031",
    sha: APPLICATION_SHA,
    ref: "refs/heads/main",
    workflow_ref:
      "seorilabs/runtime-canary/.github/workflows/org-contract.yml@refs/heads/main",
    workflow_sha: APPLICATION_SHA,
    job_workflow_ref:
      `seorilabs/.github/.github/workflows/js-static-checks-v1.yml@${BUNDLE_SHA}`,
    job_workflow_sha: BUNDLE_SHA,
    run_id: "1234",
    run_attempt: "1",
    event_name: "push",
    head_ref: "",
    base_ref: "",
    repository_visibility: "private",
    runner_environment: "self-hosted",
    ...overrides,
  };
}

test("GitHub OIDC push identity는 숫자 org/repo와 caller/called exact SHA에 결합된다", () => {
  const identity = assertGitHubActionsStaticManifestClaims(claims(), {
    repositoryId: "7001",
    applicationSourceSha: APPLICATION_SHA,
    bindingSourceSha: APPLICATION_SHA,
    defaultBranch: "main",
  });
  assert.equal(identity.workflowBundleSha, BUNDLE_SHA);
  assert.equal(identity.calledWorkflowPath, ".github/workflows/js-static-checks-v1.yml");
  assert.equal(identity.eventName, "push");
});

test("GitHub OIDC는 등록된 non-main default branch만 push source로 허용한다", () => {
  const identity = assertGitHubActionsStaticManifestClaims(claims({
    sub: "repo:seorilabs/runtime-canary:ref:refs/heads/develop",
    ref: "refs/heads/develop",
    workflow_ref:
      "seorilabs/runtime-canary/.github/workflows/org-contract.yml@refs/heads/develop",
  }), {
    repositoryId: "7001",
    applicationSourceSha: APPLICATION_SHA,
    bindingSourceSha: APPLICATION_SHA,
    defaultBranch: "develop",
  });
  assert.equal(identity.defaultBranch, "develop");
  assert.equal(identity.eventRef, "refs/heads/develop");
});

test("Godot v3 workflow는 별도 exact called path identity로 보존된다", () => {
  const identity = assertGitHubActionsStaticManifestClaims(claims({
    job_workflow_ref:
      `seorilabs/.github/.github/workflows/godot-checks-v3.yml@${BUNDLE_SHA}`,
  }), {
    repositoryId: "7001",
    applicationSourceSha: APPLICATION_SHA,
    bindingSourceSha: APPLICATION_SHA,
    defaultBranch: "main",
  });
  assert.equal(identity.calledWorkflowPath, ".github/workflows/godot-checks-v3.yml");
});

test("same-repo PR은 merge source와 signed base binding을 분리한다", () => {
  const claimIdentity = assertGitHubActionsStaticManifestClaims(claims({
    sha: APPLICATION_SHA,
    workflow_sha: APPLICATION_SHA,
    ref: "refs/pull/91/merge",
    workflow_ref:
      "seorilabs/runtime-canary/.github/workflows/org-contract.yml@refs/pull/91/merge",
    event_name: "pull_request",
    head_ref: "feature/runtime",
    base_ref: "main",
    repository_visibility: "public",
    runner_environment: "github-hosted",
  }), {
    repositoryId: "7001",
    applicationSourceSha: APPLICATION_SHA,
    bindingSourceSha: BINDING_SHA,
    defaultBranch: "main",
  });
  assert.equal(claimIdentity.requestedBindingSourceSha, BINDING_SHA);
  assert.equal(claimIdentity.callerWorkflowSha, APPLICATION_SHA);
  assert.equal(claimIdentity.applicationSourceSha, APPLICATION_SHA);
  assert.equal(claimIdentity.pullRequestNumber, 91);
});

test("OIDC identity alias, source substitution, floating workflow와 runner mismatch는 거부된다", () => {
  const expectation = {
    repositoryId: "7001",
    applicationSourceSha: APPLICATION_SHA,
    bindingSourceSha: APPLICATION_SHA,
    defaultBranch: "main",
  };
  for (const payload of [
    claims({ repository_owner_id: "1" }),
    claims({ repository_id: "7002" }),
    claims({ sha: "d".repeat(40) }),
    claims({ job_workflow_ref: "seorilabs/.github/.github/workflows/js-static-checks-v1.yml@main" }),
    claims({ job_workflow_ref: `seorilabs/.github/.github/workflows/unknown.yml@${BUNDLE_SHA}` }),
    claims({ workflow_ref: "seorilabs/runtime-canary/.github/workflows/weak.yml@refs/heads/main" }),
    claims({ event_name: "pull_request_target" }),
    claims({ runner_environment: "github-hosted", repository_visibility: "secret" }),
  ]) {
    assert.throws(
      () => assertGitHubActionsStaticManifestClaims(payload, expectation),
      /GITHUB_ACTIONS_OIDC_UNAUTHORIZED/,
    );
  }
});

test("request principal은 서명된 repo/run identity와 정확히 일치해야 한다", async () => {
  const verifier = async () => ({
    payload: claims(),
    protectedHeader: { alg: "RS256", typ: "JWT" },
  });
  const makeRequest = (principal: string) => new NextRequest(
    "https://backoffice.vzyx.xyz/api/control-plane/apps/7001/resolved-manifest",
    {
      headers: {
        authorization: "Bearer a.b.c",
        "x-seori-principal": principal,
      },
    },
  );
  const expectation = {
    repositoryId: "7001",
    applicationSourceSha: APPLICATION_SHA,
    bindingSourceSha: APPLICATION_SHA,
    defaultBranch: "main",
  };
  assert.ok(await authenticateGitHubActionsStaticManifestRequest(
    makeRequest("github-actions:7001:1234"),
    expectation,
    verifier,
  ));
  assert.equal(await authenticateGitHubActionsStaticManifestRequest(
    makeRequest("github-actions:7001:9999"),
    expectation,
    verifier,
  ), null);
  assert.equal(await authenticateGitHubActionsStaticManifestRequest(
    makeRequest("github-actions:7001:1234"),
    expectation,
    async () => ({ payload: claims(), protectedHeader: { alg: "HS256", typ: "JWT" } }),
  ), null);
});

test("same-repo PR은 GitHub App의 exact base, merge, head repo readback 뒤에만 identity를 발급한다", async () => {
  const verifier = async () => ({
    payload: claims({
      sha: APPLICATION_SHA,
      workflow_sha: APPLICATION_SHA,
      ref: "refs/pull/91/merge",
      workflow_ref:
        "seorilabs/runtime-canary/.github/workflows/org-contract.yml@refs/pull/91/merge",
      event_name: "pull_request",
      head_ref: "feature/runtime",
      base_ref: "main",
      repository_visibility: "public",
      runner_environment: "github-hosted",
    }),
    protectedHeader: { alg: "RS256", typ: "JWT" },
  });
  const request = new NextRequest(
    "https://backoffice.vzyx.xyz/api/control-plane/apps/7001/resolved-manifest",
    {
      headers: {
        authorization: "Bearer a.b.c",
        "x-seori-principal": "github-actions:7001:1234",
      },
    },
  );
  const expectation = {
    repositoryId: "7001",
    applicationSourceSha: APPLICATION_SHA,
    bindingSourceSha: BINDING_SHA,
    defaultBranch: "main",
  };
  const exactReadback = {
    number: 91,
    state: "open",
    baseRepositoryId: "7001",
    baseRepositoryFullName: "seorilabs/runtime-canary",
    baseRef: "main",
    baseSha: BINDING_SHA,
    headRepositoryId: "7001",
    headRepositoryFullName: "seorilabs/runtime-canary",
    headRef: "feature/runtime",
    mergeCommitSha: APPLICATION_SHA,
  };
  const identity = await authenticateGitHubActionsStaticManifestRequest(
    request,
    expectation,
    verifier,
    async (input) => {
      assert.deepEqual(input, {
        repositoryId: "7001",
        fullName: "seorilabs/runtime-canary",
        pullRequestNumber: 91,
      });
      return exactReadback;
    },
  );
  assert.equal(identity?.bindingSourceSha, BINDING_SHA);
  assert.equal(identity?.applicationSourceSha, APPLICATION_SHA);

  for (const readback of [
    { ...exactReadback, baseSha: "d".repeat(40) },
    { ...exactReadback, mergeCommitSha: "d".repeat(40) },
    { ...exactReadback, headRepositoryId: "7002" },
    { ...exactReadback, headRepositoryFullName: "attacker/runtime-canary" },
    { ...exactReadback, headRef: "other-feature" },
    { ...exactReadback, state: "closed" },
  ]) {
    assert.equal(
      await authenticateGitHubActionsStaticManifestRequest(
        request,
        expectation,
        verifier,
        async () => readback,
      ),
      null,
    );
  }
});

test("PR OIDC workflow_sha를 base SHA로 위조하고 fork head를 결합하면 거부된다", async () => {
  const expectation = {
    repositoryId: "7001",
    applicationSourceSha: APPLICATION_SHA,
    bindingSourceSha: BINDING_SHA,
    defaultBranch: "main",
  };
  assert.throws(
    () => assertGitHubActionsStaticManifestClaims(claims({
      sha: APPLICATION_SHA,
      workflow_sha: BINDING_SHA,
      ref: "refs/pull/91/merge",
      workflow_ref:
        "seorilabs/runtime-canary/.github/workflows/org-contract.yml@refs/pull/91/merge",
      event_name: "pull_request",
      head_ref: "feature/runtime",
      base_ref: "main",
    }), expectation),
    /GITHUB_ACTIONS_OIDC_UNAUTHORIZED/,
  );
});

test("production verifier는 GitHub issuer, audience, RS256 signature와 time claims를 검증한다", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const now = Math.floor(Date.now() / 1_000);
  const sign = async (overrides: Partial<JWTPayload> = {}) => new SignJWT({
    ...claims(),
    iat: now,
    nbf: now - 1,
    exp: now + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "test-key" })
    .sign(privateKey);
  const keySet = async () => publicKey;
  const valid = await sign();
  const verified = await verifyGitHubActionsOidcToken(valid, keySet);
  assert.equal(verified.payload.repository_id, "7001");
  await assert.rejects(
    async () => verifyGitHubActionsOidcToken(
      await sign({ aud: "wrong-audience" }),
      keySet,
    ),
  );
  await assert.rejects(
    async () => verifyGitHubActionsOidcToken(
      await sign({ iss: "https://look-alike.example" }),
      keySet,
    ),
  );
  await assert.rejects(
    async () => verifyGitHubActionsOidcToken(
      await sign({ exp: now - 60 }),
      keySet,
    ),
  );
});
