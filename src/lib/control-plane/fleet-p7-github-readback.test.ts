import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createFleetP7GitHubReadbackAdapter } from "@/lib/control-plane/fleet-p7-github-readback";
import type { FleetGitHubAppPublicSource } from "@/lib/github/app";

const CENTRAL_SHA = "a".repeat(40);
const NOW = new Date("2026-09-02T02:30:00.000Z");
const targets = [
  { id: "1250442131", fullName: "seorilabs/happy-farm", sourceSha: "b".repeat(40) },
  { id: "1265192029", fullName: "seorilabs/lizard-tycoon", sourceSha: "c".repeat(40) },
];
function inventory() {
  return { repositories: targets.map((repository) => ({ repository: { ...repository, private: true, classification: "PRODUCT_APP" } })) };
}
function contract() {
  return {
    schemaVersion: 4, github: { organization: "seorilabs", apiVersion: "2026-03-10", protection: {
      accountPlan: "TEAM", providerMode: "REPO_BRANCH_PROTECTION", rolloutMode: "SHADOW", observationMode: "READ_ONLY",
      branch: "main", repositories: ["happy-farm", "lizard-tycoon"], requiredStatusCheck: "Org Contract / Org Contract",
      preserveExisting: true, activationRequiresApproval: true,
    } },
    cloudBuild: { githubActions: { repositoryBindings: targets.map(({ id, fullName }) => ({ repositoryId: id, fullName })) } },
  };
}
function encoded(content: string) {
  const bytes = Buffer.from(content);
  return { data: { type: "file", encoding: "base64", content: bytes.toString("base64"), size: bytes.length,
    sha: createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex") } };
}
function appSource(): FleetGitHubAppPublicSource {
  return {
    observedAt: NOW.toISOString(),
    app: { id: "4124446", slug: "seorilabs-backoffice", ownerId: "283115031", ownerLogin: "seorilabs",
      active: true, webhookActive: true, webhookUrl: "https://backoffice.vzyx.xyz/api/webhooks",
      permissions: { contents: "write", metadata: "read" }, events: ["push", "repository"] },
    installation: { installationId: "142120077", appId: "4124446", targetId: "283115031", targetType: "Organization",
      accountLogin: "seorilabs", repositorySelection: "all", permissions: { contents: "write", metadata: "read" },
      events: ["push", "repository"], suspended: false, updatedAt: "2026-09-01T07:00:00.000Z", suspendedAt: null },
  };
}
function providerError(status: number, message: string) {
  return Object.assign(new Error("provider headers must never escape"), { status, response: { data: { message } } });
}
type Request = { route: string; parameters: Record<string, unknown>; count: number };
function fixture(options: {
  centralSha?: string;
  document?: unknown;
  override?: (request: Request) => { data: unknown } | void;
  app?: () => Promise<FleetGitHubAppPublicSource>;
} = {}) {
  const calls: Request[] = [];
  const request = async (route: string, parameters: Record<string, unknown>) => {
    const count = calls.filter((call) => call.route === route && call.parameters.repo === parameters.repo).length + 1;
    const current = { route, parameters, count };
    calls.push(current);
    const override = options.override?.(current);
    if (override) return override;
    if (route === "GET /repositories/{repository_id}") {
      const id = String(parameters.repository_id);
      const fullName = id === "1241442018" ? "seorilabs/.github" : targets.find((target) => target.id === id)?.fullName;
      return { data: { id: Number(id), full_name: fullName, default_branch: "main", archived: false, owner: { id: 283115031 } } };
    }
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      const sha = parameters.repo === ".github" ? options.centralSha ?? CENTRAL_SHA
        : targets.find((target) => target.fullName === "seorilabs/" + parameters.repo)?.sourceSha;
      return { data: { object: { sha } } };
    }
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      return encoded(parameters.repo === ".github" ? JSON.stringify(options.document ?? contract()) : "name: Org Contract\n");
    }
    if (route === "GET /orgs/{org}") return { data: { id: 283115031, login: "seorilabs", plan: { name: "team" } } };
    if (route === "GET /orgs/{org}/properties/schema") return { data: [] };
    if (route === "GET /repos/{owner}/{repo}/branches/{branch}/protection") throw providerError(404, "Branch not protected");
    if (route === "GET /repos/{owner}/{repo}/rules/branches/{branch}") {
      return { data: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "Seori Review" }] } }] };
    }
    throw new Error("unexpected route");
  };
  return { calls, adapter: createFleetP7GitHubReadbackAdapter({
    client: { request } as never, readAppSource: options.app ?? (async () => appSource()), now: () => NOW,
  }) };
}

test("현재 중앙 SHA의 v4 계약과 Team SHADOW 관측을 읽고 mutation은 만들지 않는다", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.read(inventory());
  assert.equal(result.currentCentralSourceSha, CENTRAL_SHA);
  assert.equal(result.centralContract.sourceSha, CENTRAL_SHA);
  assert.match(result.centralContract.contentDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(result.installation?.app_id, 4124446);
  assert.equal(result.protection?.ready, true);
  assert.equal(result.protection?.activationAllowed, false);
  assert.equal(result.protection?.existingProtectionChanged, false);
  assert.deepEqual(result.defaultBranchOrgContractCallers, targets.map(({ fullName }) => ({ fullName })));
  for (const row of result.protection?.repositories ?? []) {
    assert.equal(row.state, "OBSERVED");
    assert.equal(row.branchProtectionPresent, false);
    assert.deepEqual(row.existingStatusChecks, ["Seori Review"]);
    assert.deepEqual(row.missingStatusChecks, ["Org Contract / Org Contract"]);
    assert.equal(row.observedAt, NOW.toISOString());
  }
  for (const { route, parameters } of calls) {
    assert.ok(route.startsWith("GET /"));
    assert.equal(parameters.baseUrl, "https://api.github.com");
    assert.equal((parameters.request as { redirect: string }).redirect, "error");
    assert.equal((parameters.headers as Record<string, string>)["X-GitHub-Api-Version"], "2026-03-10");
    assert.ok(!route.includes("rulesets"), "Enterprise Evaluate 경로는 사용하지 않는다");
    if (route.includes("/contents/")) assert.match(String(parameters.ref), /^[a-f0-9]{40}$/u);
  }
});

test("dependency 코드 pin과 다른 정상적인 다음 중앙 commit도 실행 없이 관측한다", async () => {
  const { adapter } = fixture({ centralSha: "d".repeat(40) });
  assert.equal((await adapter.read(inventory())).currentCentralSourceSha, "d".repeat(40));
});

test("기존 branch protection과 유효 rules를 함께 보존한다", async () => {
  const { adapter } = fixture({ override: ({ route, parameters }) => {
    if (route.endsWith("/protection")) return { data: {
      url: "https://api.github.com/repos/seorilabs/" + parameters.repo + "/branches/main/protection",
      required_status_checks: { contexts: ["Org Contract / Org Contract", "Existing Check"] },
    } };
  } });
  const result = await adapter.read(inventory());
  assert.equal(result.protection?.ready, true);
  assert.deepEqual(result.protection?.repositories[0].existingStatusChecks, ["Existing Check", "Org Contract / Org Contract", "Seori Review"]);
  assert.equal(result.protection?.activationAllowed, false);
});

test("generic 403/404는 보호 설정 부재로 꾸미지 않는다", async () => {
  for (const status of [403, 404]) {
    const { adapter } = fixture({ override: ({ route }) => {
      if (route.endsWith("/protection")) throw providerError(status, "Not Found");
    } });
    assert.equal((await adapter.read(inventory())).protection, null);
  }
});

test("권한 없는 공개 조회와 caller 404는 unknown으로 유지한다", async () => {
  const { adapter } = fixture({ app: async () => { throw new Error("private provider error"); },
    override: ({ route, parameters }) => {
      if (route.endsWith("/properties/schema") || route.includes("/contents/") && parameters.repo !== ".github") {
        throw providerError(403, "Forbidden");
      }
    } });
  const result = await adapter.read(inventory());
  assert.equal(result.installation, null);
  assert.equal(result.organizationCustomProperties, null);
  assert.equal(result.defaultBranchOrgContractCallers, null);
  assert.equal(result.protection?.ready, true);
});

test("요금제 가시성 부족 또는 변경은 보호 조회 완료가 아니다", async () => {
  for (const plan of [undefined, { name: "enterprise" }, { name: "future-plan" }]) {
    const { adapter } = fixture({ override: ({ route }) => {
      if (route === "GET /orgs/{org}") return { data: { id: 283115031, login: "seorilabs", plan } };
    } });
    assert.equal((await adapter.read(inventory())).protection, null);
  }
});

test("선택적 관측 실패여도 credential scope 또는 폐기 실패를 숨기지 않는다", async () => {
  for (const code of ["FLEET_GITHUB_TOKEN_REVOKE_FAILED", "FLEET_GITHUB_TOKEN_PERMISSION_MISMATCH"]) {
    const { adapter } = fixture({ override: ({ route }) => {
      if (route.endsWith("/properties/schema")) throw new Error(code);
    } });
    await assert.rejects(adapter.read(inventory()), /FLEET_P7_CREDENTIAL_BOUNDARY_FAILED/u);
  }
});

test("옛 Evaluate 및 unknown schema와 보호 활성화 계약을 거부한다", async () => {
  for (const document of [
    { schemaVersion: 3, github: { ruleset: { repositories: ["happy-farm"] } } },
    { ...contract(), schemaVersion: 5 },
    { ...contract(), github: { ...contract().github, protection: { ...contract().github.protection, rolloutMode: "ACTIVE" } } },
  ]) {
    await assert.rejects(fixture({ document }).adapter.read(inventory()), /FLEET_P7_/u);
  }
});

test("central 또는 target 숫자 identity가 바뀌면 관측하지 않는다", async () => {
  for (const id of ["1241442018", targets[0].id]) {
    const { adapter } = fixture({ override: ({ route, parameters }) => {
      if (route === "GET /repositories/{repository_id}" && String(parameters.repository_id) === id) {
        return { data: { id: 1, full_name: "seorilabs/another", owner: { id: 283115031 }, default_branch: "main", archived: false } };
      }
    } });
    await assert.rejects(adapter.read(inventory()), /FLEET_P7_REPOSITORY_IDENTITY_DRIFT/u);
  }
});

test("관측 도중 중앙 또는 앱 main이 움직이면 혼합 snapshot을 버린다", async () => {
  for (const repo of [".github", "happy-farm"]) {
    const { adapter } = fixture({ override: ({ route, parameters, count }) => {
      if (route.includes("/git/ref/") && parameters.repo === repo && count === 2) return { data: { object: { sha: "f".repeat(40) } } };
    } });
    await assert.rejects(adapter.read(inventory()), /FLEET_P7_SOURCE_CHANGED_DURING_READBACK/u);
  }
});

test("inventory 대상 누락, 중복, ID 또는 SHA 불일치를 거부한다", async () => {
  const wrongId = inventory(); wrongId.repositories[0].repository.id = "101";
  const wrongSha = inventory(); wrongSha.repositories[0].repository.sourceSha = "e".repeat(40);
  const duplicate = inventory(); duplicate.repositories.push(duplicate.repositories[0]);
  for (const input of [{ repositories: inventory().repositories.slice(0, 1) }, wrongId, wrongSha, duplicate]) {
    await assert.rejects(fixture().adapter.read(input), /FLEET_P7_/u);
  }
});

test("중앙 계약의 중복·누락 target binding을 거부한다", async () => {
  for (const duplicate of [false, true]) {
    const document = contract();
    if (duplicate) document.cloudBuild.githubActions.repositoryBindings.push(document.cloudBuild.githubActions.repositoryBindings[0]);
    else document.cloudBuild.githubActions.repositoryBindings.pop();
    await assert.rejects(fixture({ document }).adapter.read(inventory()), /FLEET_P7_CENTRAL_CONTRACT_INVALID/u);
  }
});

test("GitHub content의 git blob SHA 불일치와 오류 원문 노출을 거부한다", async () => {
  const badBlob = fixture({ override: ({ route }) => {
    if (route.includes("/contents/")) return { data: { ...encoded(JSON.stringify(contract())).data, sha: "0".repeat(40) } };
  } });
  await assert.rejects(badBlob.adapter.read(inventory()), /FLEET_P7_GITHUB_CONTENT_INVALID/u);
  const failed = fixture({ override: () => { throw new Error("Authorization: Bearer do-not-print"); } });
  await assert.rejects(failed.adapter.read(inventory()), (error: Error) => error.message === "FLEET_P7_GITHUB_READBACK_FAILED");
});

test("현재 provider 직접 관측은 source를 직접 읽으며 signed inventory를 만들지 않는다", async () => {
  const { adapter } = fixture();
  const result = await adapter.observeCurrentTargets();
  assert.equal(result.protection?.ready, true);
  assert.equal(result.protection?.repositories[0].sourceSha, targets[0].sourceSha);
  assert.equal(Object.hasOwn(result, "callerMigration"), false);
  assert.equal(Object.hasOwn(result, "issuance"), false);
});
