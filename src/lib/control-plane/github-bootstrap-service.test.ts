import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { applyGitHubBootstrap, planGitHubBootstrap, reconcileGitHubBootstrap } from "./github-bootstrap-service";
import { githubBootstrapPlanDigest, githubSettingsDigest, type GitHubBootstrapPlan } from "./github-bootstrap-settings";
import type { JsonValue } from "./json";

type Dependencies = NonNullable<Parameters<typeof applyGitHubBootstrap>[1]>;
const NOW = new Date("2026-09-02T04:00:00.000Z");
function fixture() {
  const plan: GitHubBootstrapPlan = { version: 1, sourceSha: "a".repeat(40), contractDigest: "b".repeat(64),
    credentialId: "shared/github/backoffice-app-private-key", appId: "4124446", installationId: "142120077", organizationId: "283115031",
    operations: ["fleet-managed", "fleet-profile", "fleet-ruleset", "fleet-state", "happy-farm", "lizard-tycoon"].map((name, index) => ({
      kind: index < 4 ? "SCHEMA" : "VALUES", target: index < 4 ? { repositoryId: "1241442018", fullName: "seorilabs/.github" }
        : { repositoryId: index === 4 ? "1250442131" : "1265192029", fullName: `seorilabs/${name}` },
      desired: index < 4 ? { property_name: name, value_type: "single_select" } : { "fleet-ruleset": "shadow" }, beforeDigest: githubSettingsDigest(null),
    })) };
  const definition = { key: "github-repository-settings-v1:human-approved", agentKind: null, enabled: true, pausedAt: null, cancelledAt: null,
    configuration: { schemaVersion: 1, execution: "HUMAN_APPROVED_GITHUB_APP", createsPr: false, maxOperations: 6 } };
  let run = { id: "run-test", taskInput: plan, leaseGeneration: 0, status: "PENDING", repoFullName: "seorilabs/.github", createsPr: false, issueNumber: null,
    eligibleAt: NOW, updatedAt: NOW, startedAt: null as Date | null, completedAt: null as Date | null, cancelledAt: null,
    outcome: null as unknown, error: null as string | null, attempts: 0, maxAttempts: 3, occurrenceId: "occurrence-test", readbackRequestedAt: null as Date | null };
  let guard: { runId: string; activeScopeKey: string | null } | null = null;
  let clock = NOW.getTime();
  let admin = true;
  let writes = 0;
  let reads = 0;
  let failAfterWrite = false;
  let failRead = false;
  let stalePlan = false;
  let expireAfterRead = false;
  let stealGeneration = false;
  let alternatePlan = false;
  let owner = true;
  const events: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const provider = new Map<number, unknown>(plan.operations.map((_, index) => [index, null]));
  const requestResponses = new Map<string, JsonValue>();
  const indexOf = (operation: GitHubBootstrapPlan["operations"][number]) => plan.operations.findIndex((entry) => githubSettingsDigest(entry) === githubSettingsDigest(operation));
  const row = () => ({ ...run, repoGuard: guard, occurrence: { definition } });
  const models = {
    user: { findUnique: async () => ({ role: admin ? "ADMIN" : "MAINTAINER", allowlisted: true, githubId: 123n }) },
    agentRun: {
      findUnique: async () => row(),
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        if (where.id !== run.id || where.status !== run.status || where.leaseGeneration !== run.leaseGeneration
          || where.updatedAt && where.updatedAt !== run.updatedAt
          || where.eligibleAt && run.eligibleAt <= (where.eligibleAt as { gt: Date }).gt) return { count: 0 };
        const { attempts, ...rest } = data;
        run = { ...run, ...rest, ...(attempts ? { attempts: run.attempts + (attempts as { increment: number }).increment } : {}) };
        return { count: 1 };
      },
    },
    agentRepoGuard: {
      async findUnique() { return guard?.activeScopeKey ? guard : null; },
      async create({ data }: { data: { runId: string; activeScopeKey: string } }) { if (guard) throw new Error("LOCK_CONFLICT"); guard = data; return guard; },
      async updateMany({ where, data }: { where: { runId: string; activeScopeKey: string }; data: { activeScopeKey: null } }) {
        if (guard?.runId !== where.runId || guard?.activeScopeKey !== where.activeScopeKey) return { count: 0 };
        guard = { ...guard, ...data }; return { count: 1 };
      },
    },
    automationDefinition: { upsert: async () => ({ id: "definition-test", ...definition }) },
    automationOccurrence: { update: async () => ({}), upsert: async () => ({ runs: [row()] }) },
    agentRunEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data; } },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; } },
  };
  const client = { ...models, $transaction: async (fn: (tx: typeof models) => Promise<unknown>): Promise<unknown> => fn(models) };
  let transaction = Promise.resolve();
  client.$transaction = async (fn) => {
    const previous = transaction;
    let release!: () => void;
    transaction = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshot = structuredClone({ run, guard, events, audits });
    try { return await fn(client); }
    catch (error) { run = snapshot.run; guard = snapshot.guard; events.splice(0, events.length, ...snapshot.events); audits.splice(0, audits.length, ...snapshot.audits); throw error; }
    finally { release(); }
  };
  const dependencies: Dependencies = {
    client: client as unknown as Dependencies["client"], now: () => new Date(clock),
    begin: async ({ requestId }) => ({ requestHash: "c".repeat(64), replay: requestResponses.get(requestId) ?? null }),
    complete: async ({ requestId, response, audit }) => { requestResponses.set(requestId, response as JsonValue); audits.push(audit); return response as JsonValue; },
    adapter: async () => ({ plan: async () => alternatePlan ? { ...plan, sourceSha: "c".repeat(40) } : plan,
      assertOwner: async () => { if (!owner) throw new Error("GITHUB_BOOTSTRAP_ORGANIZATION_OWNER_REQUIRED"); },
      verify: async () => { if (stalePlan) throw new Error("GITHUB_BOOTSTRAP_PLAN_STALE"); },
      read: async (operation) => {
        reads += 1;
        if (failRead) throw new Error("PROVIDER_CREDENTIAL_MUST_NOT_ESCAPE");
        if (expireAfterRead) clock += 300_001;
        return provider.get(indexOf(operation));
      },
      apply: async (operation) => {
        writes += 1;
        provider.set(indexOf(operation), operation.desired);
        if (stealGeneration) run.leaseGeneration += 1;
        if (failAfterWrite) { failAfterWrite = false; throw new Error("PROVIDER_CREDENTIAL_MUST_NOT_ESCAPE"); }
      },
    }),
  };
  const request = (generation = run.leaseGeneration) => ({ actor: "operator", runId: run.id, planDigest: githubBootstrapPlanDigest(plan), expectedGeneration: generation, requestId: randomUUID() });
  return { dependencies, request, events, audits, state: () => ({ run, guard, writes, reads }), provider, plan,
    denyAdmin: () => { admin = false; }, failAfterWrite: () => { failAfterWrite = true; }, stalePlan: () => { stalePlan = true; },
    failRead: () => { failRead = true; }, expireAfterRead: () => { expireAfterRead = true; }, stealGeneration: () => { stealGeneration = true; },
    exhaustAttempts: () => { run.attempts = 3; }, expireRunning: () => { run.status = "RUNNING"; run.eligibleAt = new Date(clock - 1); },
    alternatePlan: () => { alternatePlan = true; },
    denyOwner: () => { owner = false; },
  };
}

test("계획 조회는 provider를 변경하지 않으며 멱등 재처리와 audit는 실제 저장된 plan에 결합한다", async () => {
  const item = fixture(); item.alternatePlan();
  const request = { actor: "operator", requestId: randomUUID() };
  const first = await planGitHubBootstrap(request, item.dependencies);
  const second = await planGitHubBootstrap(request, item.dependencies);
  assert.deepEqual(second, first);
  assert.equal(first.plan.sourceSha, item.plan.sourceSha);
  assert.equal(item.state().writes, 0);
  const payload = item.audits[0].payload as { planDigest: string; sourceSha: string };
  assert.equal(payload.planDigest, first.planDigest);
  assert.equal(payload.sourceSha, first.plan.sourceSha);
});

test("사람 ADMIN 권한과 exact plan/generation 없이는 provider mutation이 없다", async () => {
  const denied = fixture(); denied.denyAdmin();
  await assert.rejects(applyGitHubBootstrap(denied.request(), denied.dependencies), /HUMAN_ADMIN_REQUIRED/u);
  assert.equal(denied.state().reads, 0);
  const tampered = fixture();
  await assert.rejects(applyGitHubBootstrap({ ...tampered.request(), planDigest: "0".repeat(64) }, tampered.dependencies), /PLAN_BINDING_MISMATCH/u);
  await assert.rejects(applyGitHubBootstrap(tampered.request(5), tampered.dependencies), /BUSY_OR_STALE/u);
  assert.equal(tampered.state().writes, 0);
  const notOwner = fixture(); notOwner.denyOwner();
  await assert.rejects(applyGitHubBootstrap(notOwner.request(), notOwner.dependencies), /ORGANIZATION_OWNER_REQUIRED/u);
  assert.equal(notOwner.state().writes, 0);
  assert.equal(notOwner.state().guard, null);
});

test("동시 claim은 하나만 성공하며 모든 변경의 사전 기록·readback·완료를 별도로 남긴다", async () => {
  const item = fixture();
  const requests = [item.request(0), item.request(0)];
  const results = await Promise.allSettled(requests.map((request) => applyGitHubBootstrap(request, item.dependencies)));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(item.state().writes, 6);
  assert.equal(item.state().run.status, "SUCCEEDED");
  assert.equal(item.state().guard?.activeScopeKey, null);
  assert.equal(item.events.filter(({ type }) => type === "human_approved").length, 1);
  assert.equal(item.events.filter(({ type }) => type === "provider_write_started").length, 6);
  assert.equal(item.events.filter(({ type }) => type === "provider_readback_verified").length, 6);
  const approval = item.events.find(({ type }) => type === "human_approved")!.payload as { expiresAt: string; maxUses: number };
  assert.equal(Date.parse(approval.expiresAt) - NOW.getTime(), 300_000);
  assert.equal(approval.maxUses, 1);
  const request = requests[results.findIndex(({ status }) => status === "fulfilled")];
  await applyGitHubBootstrap(request, item.dependencies);
  assert.equal(item.state().writes, 6);
});

test("provider가 변경 후 실패하면 같은 run의 readback이 해당 변경을 반복하지 않는다", async () => {
  const item = fixture(); item.failAfterWrite();
  const first = await applyGitHubBootstrap(item.request(), item.dependencies);
  assert.equal(first.status, "FAILED");
  assert.equal(first.outcome?.state, "READBACK_REQUIRED");
  assert.equal(first.outcome?.mutationAttempts, 1);
  assert.ok(item.state().guard?.activeScopeKey);
  assert.doesNotMatch(JSON.stringify({ first, events: item.events, audits: item.audits }), /PROVIDER_CREDENTIAL_MUST_NOT_ESCAPE/u);
  const recovered = await applyGitHubBootstrap(item.request(), item.dependencies);
  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(recovered.outcome?.mutations, 5);
  assert.equal(item.state().writes, 6);
});

test("승인 이후 provider 값이 달라지면 덮어쓰지 않는다", async () => {
  const item = fixture(); item.provider.set(0, { changedByAnotherOperator: true });
  const result = await applyGitHubBootstrap(item.request(), item.dependencies);
  assert.equal(result.outcome?.code, "GITHUB_BOOTSTRAP_PROVIDER_DRIFT");
  assert.equal(item.state().writes, 0);
});

test("만료 lease는 다음 쓰기를 막고 stale generation으로 완료할 수 없다", async () => {
  const expired = fixture(); expired.expireAfterRead();
  await assert.rejects(applyGitHubBootstrap(expired.request(), expired.dependencies), /LEASE_STALE/u);
  assert.equal(expired.state().writes, 0);
  assert.equal(expired.state().run.status, "RUNNING");
  const stale = fixture(); stale.stealGeneration();
  await assert.rejects(applyGitHubBootstrap(stale.request(), stale.dependencies), /LEASE_STALE/u);
  assert.notEqual(stale.state().run.status, "SUCCEEDED");
  assert.ok(stale.state().guard?.activeScopeKey);
});

test("실행 중단 뒤 TTL이 지난 run을 다시 claim할 수 있다", async () => {
  const item = fixture(); item.expireRunning();
  const result = await applyGitHubBootstrap(item.request(), item.dependencies);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(item.state().writes, 6);
});

test("정책 변경·시도 소진 뒤에도 읽기 전용 복구로 현재 상태를 확인하고 이전 계획을 닫는다", async () => {
  const item = fixture(); item.failAfterWrite();
  await applyGitHubBootstrap(item.request(), item.dependencies);
  item.stalePlan(); item.exhaustAttempts();
  await assert.rejects(applyGitHubBootstrap(item.request(), item.dependencies), /PLAN_STALE/u);
  const result = await reconcileGitHubBootstrap(item.request(), item.dependencies);
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.outcome?.state, "CLOSED_AFTER_READBACK");
  assert.equal(result.outcome?.matched, 1);
  assert.equal(result.outcome?.mutationAttempts, 0);
  assert.equal(item.state().writes, 1);
  assert.equal(item.state().guard?.activeScopeKey, null);
  assert.equal(item.events.filter(({ type }) => type === "recovery_readback").length, 6);
});

test("복구 도중 조회가 실패하면 guard를 풀거나 새 plan을 성공 처리하지 않는다", async () => {
  const item = fixture(); item.failAfterWrite();
  await applyGitHubBootstrap(item.request(), item.dependencies);
  item.failRead();
  const result = await reconcileGitHubBootstrap(item.request(), item.dependencies);
  assert.equal(result.outcome?.state, "READBACK_REQUIRED");
  assert.doesNotMatch(JSON.stringify(result), /PROVIDER_CREDENTIAL_MUST_NOT_ESCAPE/u);
  assert.ok(item.state().guard?.activeScopeKey);
  assert.equal(item.state().run.status, "FAILED");
});
