import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  automationPolicy,
  automationIdempotencyKey,
  definitionKey,
  dueScheduleSlots,
  fleetProjectFields,
} from "@/lib/control-plane/automation";
import {
  agentLeaseActionSchema,
  agentCompletionSchema,
  agentReadbackRequiredSchema,
  agentReadbackResolutionSchema,
  agentResultSchema,
  automationDefinitionCreateSchema,
} from "@/lib/control-plane/contracts";

test("missed hourly schedule은 마지막 slot 다음부터 현재 경계까지 순서대로 복구한다", () => {
  const slots = dueScheduleSlots({
    cadence: "HOURLY",
    createdAt: new Date("2026-08-28T10:23:00.000Z"),
    lastScheduledFor: null,
    now: new Date("2026-08-28T13:59:59.999Z"),
  });
  assert.deepEqual(slots.map((slot) => slot.toISOString()), [
    "2026-08-28T11:00:00.000Z",
    "2026-08-28T12:00:00.000Z",
    "2026-08-28T13:00:00.000Z",
  ]);
  assert.deepEqual(dueScheduleSlots({
    cadence: "HOURLY",
    createdAt: new Date("2026-08-28T10:23:00.000Z"),
    lastScheduledFor: slots[1],
    now: new Date("2026-08-28T13:59:59.999Z"),
  }).map((slot) => slot.toISOString()), ["2026-08-28T13:00:00.000Z"]);
});

test("manual schedule은 자동 slot을 만들지 않고 catch-up limit은 다음 reconcile에 남긴다", () => {
  assert.deepEqual(dueScheduleSlots({
    cadence: "MANUAL",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    lastScheduledFor: null,
    now: new Date("2026-08-28T00:00:00.000Z"),
  }), []);
  const limited = dueScheduleSlots({
    cadence: "DAILY",
    createdAt: new Date("2026-08-01T01:00:00.000Z"),
    lastScheduledFor: null,
    now: new Date("2026-08-28T00:00:00.000Z"),
    limit: 2,
  });
  assert.deepEqual(limited.map((slot) => slot.toISOString()), [
    "2026-08-02T00:00:00.000Z",
    "2026-08-03T00:00:00.000Z",
  ]);
});

test("schedule과 webhook idempotency key는 동일 입력에 안정적이고 source가 바뀌면 달라진다", () => {
  const base = { definitionId: "def-1", triggerKind: "WEBHOOK" as const, triggerKey: "github:delivery-1" };
  assert.equal(automationIdempotencyKey(base), automationIdempotencyKey(base));
  assert.notEqual(automationIdempotencyKey(base), automationIdempotencyKey({ ...base, triggerKey: "github:delivery-2" }));
  assert.notEqual(
    definitionKey({ appId: "app-1", template: "repo-task-autopilot-v1", agentKind: "CODEX", cadence: "HOURLY" }),
    definitionKey({ appId: "app-1", template: "repo-task-autopilot-v1", agentKind: "CLAUDE", cadence: "HOURLY" }),
  );
  assert.notEqual(
    definitionKey({ appId: "app-1", template: "repo-task-autopilot-v1", agentKind: "CODEX", cadence: "MANUAL" }),
    definitionKey({ appId: "app-1", template: "repo-task-autopilot-v1", agentKind: "CODEX", cadence: "DAILY" }),
  );
});

test("Project projection은 고정 7개 field만 만들고 approval을 label에서 읽는다", () => {
  assert.deepEqual(fleetProjectFields({
    appSlug: "happy-farm",
    lifecycle: "QA",
    priority: "P1",
    labels: ["autopilot", "kind:platform", "approval:release"],
    agentKind: "CODEX",
    runStatus: "RUNNING",
    issueState: "OPEN",
  }), {
    priority: "P1",
    app: "happy-farm",
    kind: "platform",
    lifecycle: "QA",
    agent: "CODEX",
    approval: "release",
    outcome: "RUNNING",
  });
});

test("worker 결과 계약은 공개 usage만 허용하고 credential 후보와 임의 field를 거부한다", () => {
  const result = {
    outcomeCode: "PR_READY",
    summary: "PR #123 checks passed",
    pullRequestNumber: 123,
    pullRequestUrl: "https://github.com/seorilabs/example/pull/123",
    model: "gpt-5.6-sol",
    inputTokens: 1_000,
    outputTokens: 200,
    costMicros: 42_000,
  };
  assert.equal(agentResultSchema.safeParse(result).success, true);
  assert.equal(agentResultSchema.safeParse({ ...result, summary: "Bearer abc.def.ghi" }).success, false);
  assert.equal(agentResultSchema.safeParse({ ...result, secret: "never" }).success, false);
  assert.equal(agentResultSchema.safeParse({ ...result, pullRequestUrl: undefined }).success, false);
  assert.equal(agentLeaseActionSchema.safeParse({
    runId: "run-1",
    generation: 1,
    leaseToken: "x".repeat(32),
    error: "WORKER_FAILED",
  }).success, true);
  assert.equal(agentLeaseActionSchema.safeParse({
    runId: "run-1",
    generation: 1,
    leaseToken: "x".repeat(32),
    error: "password=hunter2",
  }).success, false);
  assert.equal(agentCompletionSchema.safeParse({
    runId: "run-1",
    generation: 1,
    leaseToken: "x".repeat(32),
  }).success, false);
  assert.equal(agentReadbackRequiredSchema.safeParse({
    runId: "run-1",
    generation: 1,
    leaseToken: "x".repeat(32),
    result: { outcomeCode: "RESULT_UNKNOWN", summary: "PR create response timed out" },
  }).success, true);
});

test("readback resolution은 원래 lease capability를 다시 요구한다", () => {
  const base = {
    runId: "run-1",
    generation: 2,
    leaseToken: "x".repeat(32),
    resolution: "RESUME",
    result: { outcomeCode: "READBACK_CONFIRMED", summary: "PR does not exist" },
  };
  assert.equal(agentReadbackResolutionSchema.safeParse(base).success, true);
  const withoutLease = {
    runId: base.runId,
    generation: base.generation,
    resolution: base.resolution,
    result: base.result,
  };
  assert.equal(agentReadbackResolutionSchema.safeParse(withoutLease).success, false);
});

test("routine 생성 validator는 공개 template, agent, cadence만 허용한다", () => {
  const valid = {
    repoId: "123",
    template: "repo-task-autopilot-v1",
    agentKind: "CODEX",
    cadence: "HOURLY",
    approvalPolicy: "READ_ONLY",
    budgetCeilingMicros: 500_000,
    maxAttempts: 3,
  };
  assert.equal(automationDefinitionCreateSchema.safeParse(valid).success, true);
  assert.equal(automationDefinitionCreateSchema.safeParse({ ...valid, agentKind: "SHELL" }).success, false);
  assert.equal(automationDefinitionCreateSchema.safeParse({ ...valid, credential: "never" }).success, false);
  assert.equal(automationPolicy({ approvalPolicy: "READ_ONLY", budgetCeilingMicros: 500_000 }).createsPr, false);
});

test("migration은 기존 enum/table을 파괴하지 않고 inbox, work dedupe, repo guard를 확장한다", () => {
  const migration = readFileSync(join(
    process.cwd(),
    "prisma/migrations/20260828210000_fleet_agent_automation/migration.sql",
  ), "utf8");
  assert.doesNotMatch(migration, /\b(?:DROP|MODIFY|CHANGE|TRUNCATE|RENAME)\b/i);
  assert.match(migration, /ADD COLUMN `workKey` VARCHAR\(191\) NULL/);
  assert.match(migration, /UNIQUE INDEX `agent_run_workKey_key`/);
  assert.match(migration, /UNIQUE INDEX `agent_repo_guard_activeScopeKey_key`/);
  assert.match(migration, /UNIQUE INDEX `automation_ingress_event_sourceKey_key`/);
  assert.match(migration, /UNIQUE INDEX `fleet_project_projection_projectNodeId_issueNodeId_key`/);
});

test("GitHub delivery와 automation inbox는 handler보다 먼저 같은 durable 경계에 기록된다", () => {
  const webhook = readFileSync(join(process.cwd(), "src/app/api/webhooks/route.ts"), "utf8");
  const service = readFileSync(join(process.cwd(), "src/lib/control-plane/automation-service.ts"), "utf8");
  assert.ok(webhook.indexOf("const delivery = await recordWebhookDelivery") < webhook.indexOf("await handleEvent(event"));
  assert.match(service, /prisma\.\$transaction[\s\S]*webhookDelivery\.create[\s\S]*automationIngressEvent\.create/);
});

test("Project projection은 claim source가 아니며 설치 template은 기본 비활성이다", () => {
  const queue = readFileSync(join(process.cwd(), "src/lib/control-plane/agent-queue.ts"), "utf8");
  const schedulerTemplate = readFileSync(join(process.cwd(), "docs/automation/automation-scheduler-cronjob.yaml"), "utf8");
  const deployedSchedulers = readFileSync(join(process.cwd(), "k8s/scheduler-cronjobs.yaml"), "utf8");
  assert.doesNotMatch(queue, /fleetProjectProjection|projectNodeId|ProjectV2/);
  assert.match(schedulerTemplate, /suspend: true/);
  assert.doesNotMatch(deployedSchedulers, /backoffice-automation-scheduler/);
});

test("PR_READY repo guard는 PR closed readback 전까지 유지된다", () => {
  const queue = readFileSync(join(process.cwd(), "src/lib/control-plane/agent-queue.ts"), "utf8");
  const webhook = readFileSync(join(process.cwd(), "src/app/api/webhooks/route.ts"), "utf8");
  assert.match(queue, /retainsPrGuard[\s\S]*outcomeCode === "PR_READY"/);
  assert.match(queue, /if \(!pullRequest \|\| pullRequest\.state === "OPEN"\) continue/);
  assert.match(webhook, /upsertPr[\s\S]*reconcileTerminalRepoGuards/);
});

test("closed 또는 blocked issue의 work key는 eligibility가 돌아왔을 때 같은 이슈를 다시 소진할 수 있게 해제한다", () => {
  const service = readFileSync(join(process.cwd(), "src/lib/control-plane/automation-service.ts"), "utf8");
  assert.match(service, /work_key_released_ineligible/);
  assert.match(service, /workKey: \{ not: null \}[\s\S]*data: \{ workKey: null \}/);
  assert.match(service, /cancellation_readback_required/);
  assert.match(service, /single Seorilabs Fleet Project|단일 Seorilabs Fleet Project/);
});

test("generic worker contract은 Codex와 Claude 설치를 각각 하나로 제한한다", () => {
  const contract = JSON.parse(readFileSync(join(
    process.cwd(),
    "docs/automation/seorilabs-worker-contract.v1.json",
  ), "utf8")) as {
    workerInstallations: Array<{ key: string; agentKind: string; maximumActiveInstallations: number }>;
  };
  assert.deepEqual(contract.workerInstallations.map((worker) => worker.agentKind).sort(), ["CLAUDE", "CODEX"]);
  assert.equal(new Set(contract.workerInstallations.map((worker) => worker.key)).size, 2);
  assert.equal(contract.workerInstallations.every((worker) => worker.maximumActiveInstallations === 1), true);
});
