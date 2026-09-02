import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGitHubBootstrapAdapter, createGitHubBootstrapWriteFetch, githubBootstrapDesiredOperations, githubBootstrapPlanDigest, githubSettingsDigest } from "./github-bootstrap-settings";
import type { FleetGitHubAppPublicSource } from "@/lib/github/app";
import type { FleetP7ReadClient } from "./fleet-p7-github-readback";
import type { FleetScopedGithubTokenIssuer } from "@/lib/github/scoped-installation-client";

const NOW = new Date("2026-09-02T04:00:00.000Z");
const CENTRAL_SHA = "a".repeat(40);
const repositories = [
  { repositoryId: "1241442018", fullName: "seorilabs/.github" },
  { repositoryId: "1250442131", fullName: "seorilabs/happy-farm" },
  { repositoryId: "1265192029", fullName: "seorilabs/lizard-tycoon" },
];
function fixture() {
  const document = {
    schemaVersion: 4,
    github: {
      organization: "seorilabs", apiVersion: "2026-03-10",
      app: { appId: 4124446, installationId: 142120077, reuseExisting: true, repositorySelection: "all" },
      trustedExecution: { appPrivateKeyCredentialId: "shared/github/backoffice-app-private-key", appId: 4124446, installationId: 142120077, ambientPersonalTokenAllowed: false },
      protection: { rolloutMode: "SHADOW", observationMode: "READ_ONLY", providerMode: "REPO_BRANCH_PROTECTION", preserveExisting: true, activationRequiresApproval: true },
      customProperties: [
        ["fleet-managed", ["true", "false"]], ["fleet-profile", ["react-native", "godot"]],
        ["fleet-ruleset", ["shadow", "active"]], ["fleet-state", ["active", "archived", "needs_input"]],
      ].map(([name, values]) => ({ property_name: name, allowed_values: values, value_type: "single_select", required: false, description: "조직 관리 항목", values_editable_by: "org_actors", require_explicit_values: true })),
      pilotValues: ["happy-farm", "lizard-tycoon"].map((repository) => ({ repository, values: {
        "fleet-managed": "true", "fleet-profile": repository === "happy-farm" ? "react-native" : "godot", "fleet-ruleset": "shadow", "fleet-state": "active",
      } })),
    },
    cloudBuild: { githubActions: { repositoryBindings: repositories.slice(1) } },
  };
  const app: FleetGitHubAppPublicSource = {
    observedAt: NOW.toISOString(),
    app: { id: "4124446", slug: "seorilabs-backoffice", ownerId: "283115031", ownerLogin: "seorilabs", active: true, webhookActive: true,
      webhookUrl: "https://backoffice.vzyx.xyz/api/webhooks", permissions: { members: "read" }, events: ["push", "repository"] },
    installation: { installationId: "142120077", appId: "4124446", targetId: "283115031", accountLogin: "seorilabs", targetType: "Organization", repositorySelection: "all",
      permissions: { metadata: "read", members: "read", organization_custom_properties: "admin", repository_custom_properties: "write" },
      events: ["push", "repository"], suspended: false, suspendedAt: null, updatedAt: NOW.toISOString() },
  };
  const schema = new Map<string, Record<string, unknown>>([["unmanaged", { property_name: "unmanaged", value_type: "string", source_type: "organization" }]]);
  const values = new Map<string, Record<string, unknown>>(repositories.slice(1).map(({ fullName }) => [fullName, { unmanaged: "preserve-me" }]));
  const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  const tokens: Array<{ repositoryIds: readonly number[]; permissions: Record<string, string | undefined> }> = [];
  let revoked = 0;
  let sourceSha = CENTRAL_SHA;
  let badBlob = false;
  let wrongRepository = false;
  let owner = true;
  let beforeWriteToken: () => void = () => {};
  const issuer: FleetScopedGithubTokenIssuer<FleetP7ReadClient> = {
    async createAccessToken(input) {
      tokens.push(input);
      if (Object.values(input.permissions).some((level) => level !== "read")) beforeWriteToken();
      return { token: "fixture-only-never-a-provider-token", expiresAt: new Date(NOW.getTime() + 300_000).toISOString(), permissions: input.permissions,
        repositories: input.repositoryIds.map((id) => ({ id, fullName: repositories.find(({ repositoryId }) => Number(repositoryId) === id)!.fullName })) };
    },
    async revokeAccessToken() { revoked += 1; },
    createClient: () => ({ async request(route, parameters = {}) {
      calls.push({ route, parameters });
      if (route === "GET /orgs/{org}/memberships/{username}") return { data: { role: owner ? "admin" : "member", state: "active", organization: { id: 283115031, login: "seorilabs" }, user: { id: 123, login: "operator", type: "User" } } };
      if (route === "GET /repositories/{repository_id}") {
        const entry = repositories.find(({ repositoryId }) => Number(repositoryId) === parameters.repository_id)!;
        return { data: { id: Number(entry.repositoryId), full_name: wrongRepository ? "seorilabs/other" : entry.fullName, default_branch: "main", archived: false, fork: false, private: true, owner: { id: 283115031 } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { data: { object: { sha: sourceSha } } };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        const bytes = Buffer.from(JSON.stringify(document));
        return { data: { type: "file", encoding: "base64", content: bytes.toString("base64"), size: bytes.length,
          sha: badBlob ? "0".repeat(40) : createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") } };
      }
      if (route === "GET /orgs/{org}/properties/schema") return { data: [...schema.values()] };
      if (route === "GET /repos/{owner}/{repo}/properties/values") return { data: Object.entries(values.get(`seorilabs/${parameters.repo}`)!).map(([property_name, value]) => ({ property_name, value })) };
      if (route === "PUT /orgs/{org}/properties/schema/{custom_property_name}") {
        const custom_property_name = parameters.custom_property_name;
        const body = Object.fromEntries(Object.entries(parameters).filter(([key]) => !["org", "custom_property_name", "baseUrl", "headers", "request"].includes(key)));
        schema.set(String(custom_property_name), { ...body, property_name: custom_property_name, source_type: "organization", default_value: null });
        return { data: null };
      }
      if (route === "PATCH /repos/{owner}/{repo}/properties/values") {
        Object.assign(values.get(`seorilabs/${parameters.repo}`)!, Object.fromEntries((parameters.properties as Array<{ property_name: string; value: unknown }>).map(({ property_name, value }) => [property_name, value])));
        return { data: null };
      }
      throw new Error("UNEXPECTED_FIXTURE_ROUTE");
    } }),
  };
  const adapter = createGitHubBootstrapAdapter({ issuer, installationId: "142120077", readApp: async () => app, now: () => NOW });
  return { adapter, calls, tokens, revoked: () => revoked, app, document, schema, values,
    changeSha: () => { sourceSha = "b".repeat(40); }, badBlob: () => { badBlob = true; }, wrongRepository: () => { wrongRepository = true; },
    denyOwner: () => { owner = false; }, beforeWriteToken: (callback: () => void) => { beforeWriteToken = callback; } };
}

test("plan은 고정 SHA의 중앙 정책과 6개 상태만 읽고 쓰기 token을 발급하지 않는다", async () => {
  const item = fixture();
  const plan = await item.adapter.plan();
  assert.equal(plan.operations.length, 6);
  assert.equal(plan.sourceSha, CENTRAL_SHA);
  assert.equal(plan.credentialId, "shared/github/backoffice-app-private-key");
  assert.equal(githubBootstrapPlanDigest(plan).length, 64);
  assert.ok(item.calls.every(({ route }) => route.startsWith("GET ")));
  assert.ok(item.tokens.every(({ permissions }) => Object.values(permissions).every((level) => level === "read")));
  assert.ok(item.tokens.every(({ repositoryIds }) => repositoryIds.length === 1));
  assert.equal(item.tokens.length, item.revoked());
  assert.doesNotMatch(JSON.stringify(plan), /fixture-only-never-a-provider-token/u);
});

test("조직 소유권은 정확한 사용자 ID와 live active/admin membership으로만 인정한다", async () => {
  const item = fixture();
  await item.adapter.assertOwner("operator", "123");
  await assert.rejects(item.adapter.assertOwner("operator", "124"), /ORGANIZATION_OWNER_REQUIRED/u);
  item.denyOwner();
  await assert.rejects(item.adapter.assertOwner("operator", "123"), /ORGANIZATION_OWNER_REQUIRED/u);
  assert.ok(item.tokens.every(({ permissions }) => permissions.members === "read" && permissions.metadata === "read"));
  assert.equal(item.revoked(), item.tokens.length);
  assert.ok(item.calls.every(({ route }) => route.startsWith("GET ")));
});

test("전체 plan 검증 전 또는 검증 후 payload 변조는 write token을 발급하지 않는다", async () => {
  const item = fixture();
  const plan = await item.adapter.plan();
  await assert.rejects(item.adapter.apply(plan.operations[0], async () => {}), /OPERATION_NOT_VERIFIED/u);
  await item.adapter.verify(plan);
  const forged = structuredClone(plan.operations[0]);
  forged.desired.description = "다른 변경";
  await assert.rejects(item.adapter.apply(forged, async () => {}), /OPERATION_NOT_VERIFIED/u);
  assert.ok(item.calls.every(({ route }) => route.startsWith("GET ")));
});

test("정확한 설정만 갱신하며 다른 속성과 브랜치·workflow·키는 건드리지 않는다", async () => {
  const item = fixture();
  const plan = await item.adapter.plan();
  await item.adapter.verify(plan);
  for (const operation of plan.operations) {
    await item.adapter.apply(operation, async () => {});
    assert.equal(githubSettingsDigest(await item.adapter.read(operation)), githubSettingsDigest(operation.desired));
  }
  assert.equal(item.schema.get("unmanaged")?.value_type, "string");
  assert.ok([...item.values.values()].every((values) => values.unmanaged === "preserve-me"));
  const writes = item.calls.filter(({ route }) => !route.startsWith("GET "));
  assert.equal(writes.length, 6);
  assert.ok(writes.every(({ route }) => /properties\/(?:schema|values)/u.test(route)));
  const writeTokens = item.tokens.filter(({ permissions }) => Object.values(permissions).some((level) => level !== "read"));
  assert.equal(writeTokens.length, 6);
  assert.ok(writeTokens.every(({ permissions }) => Object.keys(permissions).length === 2));
  assert.equal(item.tokens.length, item.revoked());
});

test("write token 발급 중 lease가 만료되면 실제 요청을 막고 token을 폐기한다", async () => {
  for (const index of [0, 4]) {
    const item = fixture();
    const plan = await item.adapter.plan();
    await item.adapter.verify(plan);
    let validLease = true;
    let checks = 0;
    item.beforeWriteToken(() => { validLease = false; });
    await assert.rejects(item.adapter.apply(plan.operations[index], async () => {
      checks += 1;
      if (!validLease) throw new Error("GITHUB_BOOTSTRAP_LEASE_STALE");
    }), /LEASE_STALE/u);
    assert.equal(checks, 1);
    assert.ok(item.calls.every(({ route }) => route.startsWith("GET ")));
    assert.equal(item.tokens.length, item.revoked());
  }
});

test("SDK 대기 뒤 실제 transport도 lease를 확인하며 결과 불명 요청을 재전송하지 않는다", async () => {
  const request = ["https://api.github.com/orgs/seorilabs/properties/schema/fleet-managed", { method: "PUT" }] as const;
  let validLease = true;
  let writes = 0;
  const transport: typeof globalThis.fetch = async () => { writes += 1; throw new Error("FIXTURE_RESPONSE_LOST"); };
  const lease = async () => { if (!validLease) throw new Error("GITHUB_BOOTSTRAP_LEASE_STALE"); };
  const expired = createGitHubBootstrapWriteFetch(lease, transport);
  validLease = false;
  await assert.rejects(expired(...request), /LEASE_STALE/u);
  assert.equal(writes, 0);
  validLease = true;
  const uncertain = createGitHubBootstrapWriteFetch(lease, transport);
  await assert.rejects(uncertain(...request), /FIXTURE_RESPONSE_LOST/u);
  await assert.rejects(uncertain(...request), /READBACK_REQUIRED/u);
  assert.equal(writes, 1);
});

test("변경된 중앙 HEAD·정책·저장소 ID는 적용 전에 중단한다", async () => {
  for (const mutate of [
    (item: ReturnType<typeof fixture>) => item.changeSha(),
    (item: ReturnType<typeof fixture>) => { item.document.github.customProperties[0].description = "달라진 정책"; },
    (item: ReturnType<typeof fixture>) => item.wrongRepository(),
  ]) {
    const item = fixture();
    const plan = await item.adapter.plan();
    mutate(item);
    await assert.rejects(item.adapter.verify(plan));
    await assert.rejects(item.adapter.apply(plan.operations[0], async () => {}), /OPERATION_NOT_VERIFIED/u);
    assert.ok(item.calls.every(({ route }) => route.startsWith("GET ")));
  }
});

test("App·계정·권한·webhook·설치 상태가 다르면 token 발급 이전에 거부한다", async () => {
  for (const mutate of [
    (source: FleetGitHubAppPublicSource) => { source.app.id = "999"; },
    (source: FleetGitHubAppPublicSource) => { source.installation.targetId = "999"; },
    (source: FleetGitHubAppPublicSource) => { source.app.webhookUrl += ".attacker.invalid"; },
    (source: FleetGitHubAppPublicSource) => { source.app.webhookActive = false; },
    (source: FleetGitHubAppPublicSource) => { source.installation.permissions.organization_custom_properties = "write"; },
    (source: FleetGitHubAppPublicSource) => { delete source.app.permissions.members; },
    (source: FleetGitHubAppPublicSource) => { delete source.installation.permissions.members; },
    (source: FleetGitHubAppPublicSource) => { source.installation.suspended = true; },
  ]) {
    const item = fixture();
    mutate(item.app);
    await assert.rejects(item.adapter.plan(), /APP_APPROVAL_REQUIRED/u);
    assert.equal(item.tokens.length, 0);
  }
});

test("확대된 보호 단계·중복 대상·개인 자격증명·변조 blob은 거부한다", async () => {
  for (const mutate of [
    (item: ReturnType<typeof fixture>) => { item.document.github.protection.rolloutMode = "ACTIVE"; },
    (item: ReturnType<typeof fixture>) => { item.document.github.pilotValues[1].repository = "happy-farm"; },
    (item: ReturnType<typeof fixture>) => { item.document.github.trustedExecution.ambientPersonalTokenAllowed = true; },
    (item: ReturnType<typeof fixture>) => item.badBlob(),
  ]) {
    const item = fixture();
    mutate(item);
    await assert.rejects(item.adapter.plan());
    assert.ok(item.calls.every(({ route }) => route.startsWith("GET ")));
  }
  assert.equal(githubBootstrapDesiredOperations(fixture().document).length, 6);
});
