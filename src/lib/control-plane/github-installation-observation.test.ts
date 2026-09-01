import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  evaluateGitHubInstallationCapabilities,
  githubInstallationProviderPayload,
  recordGitHubInstallationObservations,
} from "@/lib/control-plane/github-installation-observation";
import {
  normalizeGitHubInstallationPublicState,
  type GitHubInstallationPublicState,
} from "@/lib/github/installation-public-state";

function grantedState(): GitHubInstallationPublicState {
  return {
    installationId: "101",
    appId: "202",
    targetId: "303",
    repositorySelection: "all",
    targetType: "Organization",
    accountLogin: "seorilabs",
    permissions: {
      actions: "write",
      checks: "write",
      contents: "write",
      environments: "write",
      issues: "write",
      metadata: "read",
      organization_actions_variables: "write",
      organization_administration: "write",
      organization_custom_properties: "admin",
      organization_projects: "write",
      organization_secrets: "write",
      pull_requests: "write",
      workflows: "write",
    },
    events: ["issue_comment", "issues", "pull_request", "push", "repository", "workflow_run"],
    suspended: false,
  };
}

test("GitHub installation 응답은 공개 grant만 정렬하고 URL/token 후보를 버린다", () => {
  const state = normalizeGitHubInstallationPublicState({
    id: 101,
    app_id: 202,
    target_id: 303,
    repository_selection: "all",
    target_type: "Organization",
    account: { id: 303, login: "seorilabs", html_url: "https://example.invalid/private" },
    permissions: { pull_requests: "write", metadata: "read" },
    events: ["push", "push", "repository"],
    suspended_at: null,
    access_tokens_url: "https://api.github.com/app/installations/101/access_tokens",
    private_key: "must-not-survive",
  });
  assert.deepEqual(state.permissions, { metadata: "read", pull_requests: "write" });
  assert.deepEqual(state.events, ["push", "repository"]);
  assert.doesNotMatch(JSON.stringify(state), /access_tokens_url|private_key|example\.invalid/);
  assert.throws(() => normalizeGitHubInstallationPublicState({
    id: 101,
    app_id: 202,
    target_id: 999,
    repository_selection: "all",
    target_type: "Organization",
    account: { id: 303, login: "seorilabs" },
    permissions: {},
    events: [],
    suspended_at: null,
  }), /GITHUB_INSTALLATION_PUBLIC_STATE_INVALID/);
});

test("Gate 1 capability는 full-org, exact permission, required event를 각각 fail-closed한다", () => {
  const ready = evaluateGitHubInstallationCapabilities(grantedState(), "seorilabs");
  assert.equal(Object.values(ready).every((capability) => capability.state === "GRANTED"), true);

  const blocked = evaluateGitHubInstallationCapabilities({
    ...grantedState(),
    repositorySelection: "selected",
    permissions: { metadata: "read", contents: "read", pull_requests: "read" },
    events: ["push"],
  }, "seorilabs");
  assert.equal(blocked.repositoryDiscovery.state, "MISSING_REQUIREMENT");
  assert.ok(blocked.repositoryDiscovery.missing.includes("installation:all-repositories"));
  assert.ok(blocked.repositoryDiscovery.missing.includes("event:repository"));
  assert.ok(blocked.callerBootstrapPullRequest.missing.includes("permission:pull_requests:write"));
  assert.ok(blocked.organizationVariables.missing.includes("permission:organization_actions_variables:write"));
  assert.ok(blocked.organizationRulesets.missing.includes("permission:organization_administration:write"));
  assert.ok(blocked.organizationProjects.missing.includes("permission:organization_projects:write"));
});

test("공개 installation readback은 앱별 ProviderObservation과 repository binding만 기록한다", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await recordGitHubInstallationObservations({
    organization: "seorilabs",
    occurrenceId: "occurrence-1",
  }, {
    getPublicState: async () => grantedState(),
    listApps: async () => [{
      id: "app-1",
      repoId: 42n,
      repoFullName: "seorilabs/sample-app",
    }],
    record: async (input) => {
      calls.push(input as unknown as Record<string, unknown>);
      return { duplicate: false } as never;
    },
    now: () => new Date("2026-08-28T08:00:00.000Z"),
  });
  assert.deepEqual(result, {
    observed: 1,
    duplicate: 0,
    failed: 0,
    state: "completed",
    gate: "READY",
  });
  assert.equal(calls[0]?.provider, "github");
  assert.equal(calls[0]?.resourceType, "github-app-installation");
  assert.equal(calls[0]?.idempotencyKey, "github-installation:occurrence-1:42");
  assert.deepEqual((calls[0]?.externalBinding as Record<string, unknown>)?.externalId, "101:42");
  assert.deepEqual(
    githubInstallationProviderPayload(grantedState(), "seorilabs"),
    calls[0]?.payload,
  );
  assert.doesNotMatch(JSON.stringify(calls, (_key, value) => (
    typeof value === "bigint" ? value.toString() : value
  )), /token|password|private.?key|authorization/i);
});

test("installation readback 실패는 provider 원문 없이 BLOCKED partial로 수렴한다", async () => {
  const result = await recordGitHubInstallationObservations({
    organization: "seorilabs",
    occurrenceId: "occurrence-failed",
  }, {
    getPublicState: async () => {
      throw new Error("provider request header with private credential");
    },
    listApps: async () => {
      throw new Error("must not list apps after readback failure");
    },
    record: async () => {
      throw new Error("must not record after readback failure");
    },
    now: () => new Date("2026-08-28T08:00:00.000Z"),
  });
  assert.deepEqual(result, {
    observed: 0,
    duplicate: 0,
    failed: 1,
    state: "partial",
    gate: "BLOCKED",
  });
  assert.doesNotMatch(JSON.stringify(result), /provider|header|credential/i);
});

test("scheduler route와 Fleet UI는 read-only installation observation을 연결한다", () => {
  const route = readFileSync(join(
    process.cwd(),
    "src/app/api/admin/repository-discovery/backfill/route.ts",
  ), "utf8");
  const page = readFileSync(join(
    process.cwd(),
    "src/app/(app)/apps/[id]/fleet/page.tsx",
  ), "utf8");
  assert.match(route, /recordGitHubInstallationObservations/);
  assert.match(page, /GitHub 연동 권한/);
  assert.match(page, /권한 있음은 GitHub 연동 권한만 뜻합니다/);
  assert.match(page, /개별 작업의 실행 승인이나 변경 완료를 뜻하지 않습니다/);
  assert.doesNotMatch(route, /pulls\.create|repos\.update|createWorkflowDispatch|createOrUpdateOrgSecret/);
});
