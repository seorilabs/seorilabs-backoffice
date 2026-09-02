import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { beginAutomationMutation, completeAutomationMutation } from "./automation-mutation";
import {
  githubBootstrapPlanSchema, githubBootstrapPlanDigest, githubSettingsDigest,
  productionGitHubBootstrapAdapter, type GitHubBootstrapAdapter, type GitHubBootstrapPlan,
} from "./github-bootstrap-settings";

const DEFINITION = "github-repository-settings-v1:human-approved";
const LOCK = "github-repository-settings:283115031";
const LEASE_MS = 5 * 60_000;
const POLICY = { schemaVersion: 1, execution: "HUMAN_APPROVED_GITHUB_APP", createsPr: false, maxOperations: 6 };
const requestId = z.string().uuid();
const applySchema = z.object({ runId: z.string().min(1).max(191), planDigest: z.string().regex(/^[a-f0-9]{64}$/u), expectedGeneration: z.number().int().nonnegative(), requestId }).strict();
export interface GitHubBootstrapView {
  runId: string;
  planDigest: string;
  generation: number;
  status: string;
  changes: number;
  canApply: boolean;
  plan: GitHubBootstrapPlan;
  outcome: { state: "VERIFIED" | "READBACK_REQUIRED" | "CLOSED_AFTER_READBACK"; mutations: number; mutationAttempts: number; matched: number; observedAt: string; code: string | null } | null;
}
interface Dependencies {
  client: typeof prisma;
  adapter: () => Promise<GitHubBootstrapAdapter>;
  now: () => Date;
  begin: typeof beginAutomationMutation;
  complete: typeof completeAutomationMutation;
}
const defaults: Dependencies = { client: prisma, adapter: productionGitHubBootstrapAdapter, now: () => new Date(), begin: beginAutomationMutation, complete: completeAutomationMutation };
function fail(code: string): never { throw new Error(code); }
function publicCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return /^GITHUB_BOOTSTRAP_[A-Z_]{1,100}$/u.test(code) ? code : "GITHUB_BOOTSTRAP_PROVIDER_OR_STORAGE_FAILED";
}
function view(run: { id: string; taskInput: Prisma.JsonValue | null; leaseGeneration: number; status: string; outcome: Prisma.JsonValue | null; eligibleAt: Date }): GitHubBootstrapView {
  const plan = githubBootstrapPlanSchema.parse(run.taskInput);
  return { runId: run.id, planDigest: githubBootstrapPlanDigest(plan), generation: run.leaseGeneration, status: run.status,
    changes: plan.operations.filter((operation) => operation.beforeDigest !== githubSettingsDigest(operation.desired)).length,
    canApply: run.status === "PENDING" || run.status === "FAILED" || run.status === "RUNNING" && run.eligibleAt <= new Date(),
    plan, outcome: run.outcome as unknown as GitHubBootstrapView["outcome"] };
}
async function requireAdmin(actor: string, dependencies: Dependencies): Promise<{ githubId: string }> {
  const user = await dependencies.client.user.findUnique({ where: { login: actor }, select: { role: true, allowlisted: true, githubId: true } });
  if (user?.role !== "ADMIN" || !user.allowlisted) fail("GITHUB_BOOTSTRAP_HUMAN_ADMIN_REQUIRED");
  return { githubId: String(user.githubId) };
}
async function readRun(id: string, dependencies: Dependencies) {
  const run = await dependencies.client.agentRun.findUnique({ where: { id }, include: { occurrence: { include: { definition: true } }, repoGuard: true } });
  if (!run || run.occurrence.definition.key !== DEFINITION || run.occurrence.definition.agentKind !== null
    || githubSettingsDigest(run.occurrence.definition.configuration) !== githubSettingsDigest(POLICY)
    || run.repoFullName !== "seorilabs/.github" || run.createsPr || run.issueNumber !== null) fail("GITHUB_BOOTSTRAP_RUN_BINDING_INVALID");
  return run;
}

/** No GitHub mutations: fixed central desired state + current provider state become an immutable run. */
export async function planGitHubBootstrap(input: { actor: string; requestId: string }, dependencies = defaults): Promise<GitHubBootstrapView> {
  await requireAdmin(input.actor, dependencies);
  requestId.parse(input.requestId);
  const mutation = { actor: input.actor, requestId: `github-bootstrap-plan:${input.requestId}`, operation: "github.bootstrap.plan", targetKey: LOCK, request: {} };
  const begun = await dependencies.begin(mutation);
  if (begun.replay) return begun.replay as unknown as GitHubBootstrapView;
  // An uncertain previous execution is resumed/read back, never replaced by a new mutation run.
  const guard = await dependencies.client.agentRepoGuard.findUnique({ where: { activeScopeKey: LOCK } });
  if (guard) return await dependencies.complete({ ...mutation, requestHash: begun.requestHash, response: view(await readRun(guard.runId, dependencies)),
    audit: { action: "github.bootstrap.plan.resume", entityType: "AgentRun", entityId: guard.runId } }) as unknown as GitHubBootstrapView;
  const adapter = await dependencies.adapter();
  const plan = await adapter.plan();
  const row = await dependencies.client.$transaction(async (tx) => {
    const definition = await tx.automationDefinition.upsert({ where: { key: DEFINITION },
      update: {}, create: { key: DEFINITION, template: "github-repository-settings-v1", configuration: POLICY, enabled: true, maxAttempts: 3 } });
    if (definition.agentKind !== null || githubSettingsDigest(definition.configuration) !== githubSettingsDigest(POLICY)) fail("GITHUB_BOOTSTRAP_RUN_BINDING_INVALID");
    const occurrence = await tx.automationOccurrence.upsert({ where: { idempotencyKey: mutation.requestId }, update: {},
      create: { definitionId: definition.id, scheduledFor: dependencies.now(), idempotencyKey: mutation.requestId, triggerKind: "HUMAN_UI", triggerKey: mutation.requestId,
        runs: { create: { repoFullName: "seorilabs/.github", labels: [], createsPr: false, taskInput: plan as Prisma.InputJsonValue, maxAttempts: 3 } } },
      include: { runs: true } });
    if (occurrence.runs.length !== 1) fail("GITHUB_BOOTSTRAP_RUN_BINDING_INVALID");
    return occurrence.runs[0];
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  const saved = view(row);
  return await dependencies.complete({ ...mutation, requestHash: begun.requestHash, response: saved,
    audit: { action: "github.bootstrap.plan", entityType: "AgentRun", entityId: row.id, payload: { planDigest: saved.planDigest, sourceSha: saved.plan.sourceSha } } }) as unknown as GitHubBootstrapView;
}

export async function latestGitHubBootstrap(dependencies = defaults): Promise<GitHubBootstrapView | null> {
  const guard = await dependencies.client.agentRepoGuard.findUnique({ where: { activeScopeKey: LOCK } });
  if (guard) return view(await readRun(guard.runId, dependencies));
  const row = await dependencies.client.agentRun.findFirst({ where: { occurrence: { definition: { key: DEFINITION } } }, orderBy: { createdAt: "desc" } });
  return row ? view(row) : null;
}

async function assertLease(runId: string, generation: number, dependencies: Dependencies): Promise<void> {
  const row = await readRun(runId, dependencies);
  if (row.status !== "RUNNING" || row.leaseGeneration !== generation || row.eligibleAt <= dependencies.now()
    || row.repoGuard?.activeScopeKey !== LOCK || !row.occurrence.definition.enabled || row.occurrence.definition.pausedAt || row.occurrence.definition.cancelledAt) fail("GITHUB_BOOTSTRAP_LEASE_STALE");
}

async function claim(body: z.infer<typeof applySchema>, actor: string, planned: GitHubBootstrapView, readOnly: boolean, dependencies: Dependencies): Promise<number> {
  const principal = await requireAdmin(actor, dependencies);
  const expiresAt = new Date(dependencies.now().getTime() + LEASE_MS);
  return dependencies.client.$transaction(async (tx) => {
    const row = await tx.agentRun.findUnique({ where: { id: body.runId }, include: { repoGuard: true, occurrence: { include: { definition: true } } } });
    if (!row || row.leaseGeneration !== body.expectedGeneration || !["PENDING", "FAILED", "RUNNING"].includes(row.status)
      || row.status === "RUNNING" && row.eligibleAt > dependencies.now() || row.cancelledAt
      || !row.occurrence.definition.enabled || row.occurrence.definition.pausedAt || row.occurrence.definition.cancelledAt
      || githubBootstrapPlanDigest(githubBootstrapPlanSchema.parse(row.taskInput)) !== body.planDigest) fail("GITHUB_BOOTSTRAP_EXECUTION_BUSY_OR_STALE");
    if (!readOnly && row.attempts >= row.maxAttempts) fail("GITHUB_BOOTSTRAP_MANUAL_RECOVERY_REQUIRED");
    if (!row.repoGuard) await tx.agentRepoGuard.create({ data: { runId: row.id, repoFullName: row.repoFullName, activeScopeKey: LOCK } });
    else if (row.repoGuard.activeScopeKey !== LOCK) fail("GITHUB_BOOTSTRAP_EXECUTION_BUSY_OR_STALE");
    const next = row.leaseGeneration + 1;
    const claimed = await tx.agentRun.updateMany({ where: { id: row.id, status: row.status, leaseGeneration: row.leaseGeneration, updatedAt: row.updatedAt },
      data: { status: "RUNNING", leaseGeneration: next, attempts: { increment: readOnly ? 0 : 1 }, eligibleAt: expiresAt, startedAt: dependencies.now(), completedAt: null } });
    if (claimed.count !== 1) fail("GITHUB_BOOTSTRAP_EXECUTION_BUSY_OR_STALE");
    await tx.automationOccurrence.update({ where: { id: row.occurrenceId }, data: { status: "RUNNING" } });
    await tx.agentRunEvent.create({ data: { runId: row.id, generation: next, requestId: `github-bootstrap-approval:${row.id}:${next}`, type: readOnly ? "readback_claimed" : "human_approved", actor,
      payload: { planDigest: body.planDigest, sourceSha: planned.plan.sourceSha, organizationId: planned.plan.organizationId, approvedByGitHubId: principal.githubId,
        credentialId: planned.plan.credentialId, expiresAt: expiresAt.toISOString(), maxUses: 1, operationCount: planned.plan.operations.length } } });
    return next;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function settle(body: z.infer<typeof applySchema>, actor: string, planned: GitHubBootstrapView, occurrenceId: string,
  generation: number, outcome: NonNullable<GitHubBootstrapView["outcome"]>, dependencies: Dependencies): Promise<void> {
  const status = outcome.state === "VERIFIED" ? "SUCCEEDED" : outcome.state === "CLOSED_AFTER_READBACK" ? "CANCELLED" : "FAILED";
  await dependencies.client.$transaction(async (tx) => {
    const settled = await tx.agentRun.updateMany({ where: { id: body.runId, status: "RUNNING", leaseGeneration: generation, eligibleAt: { gt: dependencies.now() } },
      data: { status, error: outcome.code, outcome, completedAt: dependencies.now(), readbackRequestedAt: status === "FAILED" ? dependencies.now() : null } });
    if (settled.count !== 1) fail("GITHUB_BOOTSTRAP_LEASE_STALE");
    await tx.automationOccurrence.update({ where: { id: occurrenceId }, data: { status: status === "SUCCEEDED" ? "COMPLETED" : "FAILED", result: outcome, completedAt: dependencies.now() } });
    if (status !== "FAILED") await tx.agentRepoGuard.updateMany({ where: { runId: body.runId, activeScopeKey: LOCK }, data: { activeScopeKey: null, releasedAt: dependencies.now() } });
    await tx.agentRunEvent.create({ data: { runId: body.runId, generation, requestId: `github-bootstrap-settle:${body.runId}:${generation}`, type: status === "FAILED" ? "readback_required" : "completed", actor, payload: outcome } });
    await tx.auditLog.create({ data: { actorLogin: actor, action: "github.bootstrap.execution", entityType: "AgentRun", entityId: body.runId,
      payload: { planDigest: body.planDigest, sourceSha: planned.plan.sourceSha, generation, ...outcome } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Called only by the authenticated ADMIN human UI, never an agent header or generic worker claim. */
export async function applyGitHubBootstrap(input: z.infer<typeof applySchema> & { actor: string }, dependencies = defaults): Promise<GitHubBootstrapView> {
  const { actor, ...raw } = input;
  const body = applySchema.parse(raw);
  await requireAdmin(actor, dependencies);
  const mutation = { actor, requestId: `github-bootstrap-apply:${body.requestId}`, operation: "github.bootstrap.apply", targetKey: LOCK,
    request: { runId: body.runId, planDigest: body.planDigest, expectedGeneration: body.expectedGeneration } };
  const begun = await dependencies.begin(mutation);
  if (begun.replay) return begun.replay as unknown as GitHubBootstrapView;
  const original = await readRun(body.runId, dependencies);
  const planned = view(original);
  if (planned.planDigest !== body.planDigest) fail("GITHUB_BOOTSTRAP_PLAN_BINDING_MISMATCH");
  if (original.status === "SUCCEEDED") return await dependencies.complete({ ...mutation, requestHash: begun.requestHash, response: planned,
    audit: { action: "github.bootstrap.noop", entityType: "AgentRun", entityId: body.runId } }) as unknown as GitHubBootstrapView;
  const adapter = await dependencies.adapter();
  await adapter.verify(planned.plan);
  await adapter.assertOwner(actor, (await requireAdmin(actor, dependencies)).githubId);
  const generation = await claim(body, actor, planned, false, dependencies);

  let mutations = 0;
  let mutationAttempts = 0;
  let matched = 0;
  let code: string | null = null;
  try {
    for (const [index, operation] of planned.plan.operations.entries()) {
      await requireAdmin(actor, dependencies);
      await assertLease(body.runId, generation, dependencies);
      const beforeDigest = githubSettingsDigest(await adapter.read(operation));
      const desiredDigest = githubSettingsDigest(operation.desired);
      if (beforeDigest !== desiredDigest) {
        if (beforeDigest !== operation.beforeDigest) fail("GITHUB_BOOTSTRAP_PROVIDER_DRIFT");
        await adapter.assertOwner(actor, (await requireAdmin(actor, dependencies)).githubId);
        await assertLease(body.runId, generation, dependencies);
        await dependencies.client.agentRunEvent.create({ data: { runId: body.runId, generation,
          requestId: `github-bootstrap-attempt:${body.runId}:${generation}:${index}`, type: "provider_write_started", actor,
          payload: { index, target: operation.target, kind: operation.kind, desiredDigest, beforeDigest, sourceSha: planned.plan.sourceSha } } });
        mutationAttempts += 1;
        await adapter.apply(operation);
        mutations += 1;
      }
      if (githubSettingsDigest(await adapter.read(operation)) !== desiredDigest) fail("GITHUB_BOOTSTRAP_READBACK_MISMATCH");
      await assertLease(body.runId, generation, dependencies);
      await dependencies.client.agentRunEvent.create({ data: { runId: body.runId, generation,
        requestId: `github-bootstrap-readback:${body.runId}:${generation}:${index}`, type: "provider_readback_verified", actor,
        payload: { index, target: operation.target, kind: operation.kind, desiredDigest, beforeDigest, mutationSkipped: beforeDigest === desiredDigest } } });
      matched += 1;
    }
  } catch (error) { code = publicCode(error); }
  const outcome: NonNullable<GitHubBootstrapView["outcome"]> = { state: code ? "READBACK_REQUIRED" : "VERIFIED", mutations, mutationAttempts, matched, observedAt: dependencies.now().toISOString(), code };
  await settle(body, actor, planned, original.occurrenceId, generation, outcome, dependencies);
  return await dependencies.complete({ ...mutation, requestHash: begun.requestHash, response: view(await readRun(body.runId, dependencies)),
    audit: { action: "github.bootstrap.apply", entityType: "AgentRun", entityId: body.runId, payload: { planDigest: body.planDigest, generation, ...outcome } } }) as unknown as GitHubBootstrapView;
}

/** Explicit human recovery: observe every target before releasing an uncertain run; never roll back provider settings. */
export async function reconcileGitHubBootstrap(input: z.infer<typeof applySchema> & { actor: string }, dependencies = defaults): Promise<GitHubBootstrapView> {
  const { actor, ...raw } = input;
  const body = applySchema.parse(raw);
  await requireAdmin(actor, dependencies);
  const mutation = { actor, requestId: `github-bootstrap-reconcile:${body.requestId}`, operation: "github.bootstrap.reconcile", targetKey: LOCK,
    request: { runId: body.runId, planDigest: body.planDigest, expectedGeneration: body.expectedGeneration } };
  const begun = await dependencies.begin(mutation);
  if (begun.replay) return begun.replay as unknown as GitHubBootstrapView;
  const original = await readRun(body.runId, dependencies);
  const planned = view(original);
  if (planned.planDigest !== body.planDigest) fail("GITHUB_BOOTSTRAP_PLAN_BINDING_MISMATCH");
  if (["SUCCEEDED", "CANCELLED"].includes(original.status)) return await dependencies.complete({ ...mutation, requestHash: begun.requestHash, response: planned,
    audit: { action: "github.bootstrap.noop", entityType: "AgentRun", entityId: body.runId } }) as unknown as GitHubBootstrapView;
  const adapter = await dependencies.adapter();
  const generation = await claim(body, actor, planned, true, dependencies);
  let matched = 0;
  let code: string | null = null;
  // Do not require current policy equality: a superseded plan must still be safely closable after readback.
  try {
    for (const [index, operation] of planned.plan.operations.entries()) {
      await requireAdmin(actor, dependencies);
      await assertLease(body.runId, generation, dependencies);
      const readbackDigest = githubSettingsDigest(await adapter.read(operation));
      const matches = readbackDigest === githubSettingsDigest(operation.desired);
      await assertLease(body.runId, generation, dependencies);
      await dependencies.client.agentRunEvent.create({ data: { runId: body.runId, generation, actor, type: "recovery_readback",
        requestId: `github-bootstrap-recovery:${body.runId}:${generation}:${index}`, payload: { index, target: operation.target, readbackDigest, matches, mutationAttempted: false } } });
      if (matches) matched += 1;
    }
  } catch (error) { code = publicCode(error); }
  const outcome: NonNullable<GitHubBootstrapView["outcome"]> = { state: code ? "READBACK_REQUIRED" : matched === planned.plan.operations.length ? "VERIFIED" : "CLOSED_AFTER_READBACK",
    mutations: 0, mutationAttempts: 0, matched, observedAt: dependencies.now().toISOString(), code };
  await settle(body, actor, planned, original.occurrenceId, generation, outcome, dependencies);
  return await dependencies.complete({ ...mutation, requestHash: begun.requestHash, response: view(await readRun(body.runId, dependencies)),
    audit: { action: "github.bootstrap.reconcile", entityType: "AgentRun", entityId: body.runId, payload: { planDigest: body.planDigest, generation, ...outcome } } }) as unknown as GitHubBootstrapView;
}
