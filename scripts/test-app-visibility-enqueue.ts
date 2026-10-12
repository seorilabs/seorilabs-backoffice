import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { prisma } from "@/lib/prisma";
import { setAppVisibility } from "@/lib/control-plane/app-visibility-service";
import { retryAgentRun } from "@/lib/control-plane/automation-service";
import { automationPolicy } from "@/lib/control-plane/automation-catalog";
import { lockAppForNewWork } from "@/lib/control-plane/app-work-lock";
import { setAppStatusCore } from "@/lib/core/app-status";
import { publishSignal } from "@/lib/insights/service";
import { enqueueAppOperation } from "@/lib/app-ops/runs";
import { enqueuePlatformOperation } from "@/lib/platform/runs";
import { preparePlatformOperation } from "@/lib/platform/operations";
import { createOperatorCommand, confirmOperatorCommand } from "@/lib/discord/command-runs";

const url = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/backoffice_iap_qa") {
  throw new Error("ISOLATED_DATABASE_REQUIRED");
}

async function fixture() {
  const id = `qa-enqueue-${randomUUID()}`;
  const app = await prisma.app.create({data: {
    id, slug: id, repoFullName: `qa/${id}`, displayName: "작업 등록 경합 검증",
    type: "GAME", engine: "GODOT", marketTargets: [],
  }});
  const admin = await prisma.user.create({data: {
    login: id, githubId: BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`), role: "ADMIN", allowlisted: true,
  }});
  const hide = () => setAppVisibility({
    appId: app.id, expectedUpdatedAt: app.updatedAt.toISOString(), status: "DEPRECATED",
    reason: "격리 DB 경합 재현", requestId: id, actor: {kind: "user", login: admin.login},
  });
  return {app, admin, hide};
}

async function assertNoAppOperations(appId: string) {
  assert.equal(await prisma.appOperationRun.count({where: {appId}}), 0);
  assert.equal(await prisma.auditLog.count({where: {entityId: appId, action: {not: "app.visibility"}}}), 0);
}

test("앱 조회 후 숨김이 먼저 완료되면 legacy 작업과 감사 기록을 등록하지 않는다", async () => {
  const {app, admin, hide} = await fixture();
  const staleInput = {
    appId: app.id, repoFullName: app.repoFullName, actorLogin: admin.login, requestId: randomUUID(),
    prepared: {
      operation: {id: "readback", label: "조회", intent: "read" as const, risk: "low" as const,
        confirmation: "none" as const, inputs: []},
      operationKey: "qa.readback", params: {}, paramsJson: "{}", reason: null,
    },
  };
  await hide();
  await assert.rejects(enqueueAppOperation(staleInput), /비활성 앱/);
  await assertNoAppOperations(app.id);
});

test("중앙 IAP 요청 준비 후 숨김이 먼저 완료되면 지급 요청을 등록하지 않는다", async () => {
  const {app, admin, hide} = await fixture();
  const prepared = preparePlatformOperation({
    operation: "platform.iap.grant-entitlement", requestId: randomUUID(), appSlug: app.slug,
    platformUserId: "pu_01J00000000000000000000000", entitlementId: "sp_galaxy_gecko",
    reason: "internal_validation", expectedEnvironment: "production",
    serverConfirmation: `GRANT ${app.slug} pu_01J00000000000000000000000 sp_galaxy_gecko`,
  });
  await hide();
  await assert.rejects(enqueuePlatformOperation({appId: app.id, actorLogin: admin.login, prepared}), /비활성 앱/);
  await assertNoAppOperations(app.id);
});

test("숨긴 앱에는 Discord 작업을 만들거나 기존 확인 대기를 실행 대기로 바꾸지 않는다", async () => {
  const {app, hide} = await fixture();
  const input = {sourceInteractionId: randomUUID(), appId: app.id, operation: "qa.no-external-execution",
    actorDiscordUserId: "qa", channelId: "qa", needsConfirmation: true};
  const awaiting = await createOperatorCommand(input);
  await hide();
  await assert.rejects(createOperatorCommand({...input, sourceInteractionId: randomUUID(), needsConfirmation: false}), /비활성 앱/);
  await assert.rejects(confirmOperatorCommand({id: awaiting.id, actorDiscordUserId: "qa", channelId: "qa"}), /비활성 앱/);
  assert.equal((await prisma.operatorCommandRun.findUniqueOrThrow({where: {id: awaiting.id}})).status, "AWAITING_CONFIRMATION");
  assert.equal(await prisma.operatorCommandRun.count({where: {appId: app.id}}), 1);
});

test("앱 조회 후 숨김이 완료되면 늦은 운영 중지 요청이 숨김을 덮어쓰지 않는다", async () => {
  const {app, admin, hide} = await fixture();
  const findFirst = prisma.app.findFirst.bind(prisma.app);
  let selected!: () => void;
  let resume!: () => void;
  const selection = new Promise<void>((resolve) => { selected = resolve; });
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  prisma.app.findFirst = (async (...args: Parameters<typeof findFirst>) => {
    const result = await findFirst(...args);
    selected();
    await resumed;
    return result;
  }) as typeof prisma.app.findFirst;
  const pause = setAppStatusCore({idOrSlug: app.id, status: "PAUSED", actorLogin: admin.login});
  await selection;
  await hide();
  resume();
  try {
    await assert.rejects(pause, /비활성 앱/);
  } finally {
    prisma.app.findFirst = findFirst;
  }
  assert.equal((await prisma.app.findUniqueOrThrow({where: {id: app.id}})).status, "DEPRECATED");
  assert.equal(await prisma.auditLog.count({where: {entityId: app.id, action: "app.status"}}), 0);
});

test("숨긴 앱의 종료된 자동 작업을 수동 재시도로 다시 등록하지 않는다", async () => {
  const {app, admin, hide} = await fixture();
  await prisma.repositoryRegistration.create({data: {
    repoId: admin.githubId, repoFullName: app.repoFullName, defaultBranch: "main", status: "MANAGED",
    managementKind: "APP", lastDefaultPushSha: "f".repeat(40), lastReconciledSha: "f".repeat(40),
  }});
  const definition = await prisma.automationDefinition.create({data: {
    key: app.id, appId: app.id, template: "repo-task-autopilot-v1", agentKind: "CODEX",
    configuration: automationPolicy({approvalPolicy: "READ_ONLY", budgetCeilingMicros: 1000}),
  }});
  const occurrence = await prisma.automationOccurrence.create({data: {
    definitionId: definition.id, scheduledFor: new Date(), idempotencyKey: app.id, status: "FAILED",
  }});
  const run = await prisma.agentRun.create({data: {
    appId: app.id, occurrenceId: occurrence.id, repoFullName: app.repoFullName, labels: [], status: "DEAD_LETTER",
  }});
  await hide();
  await assert.rejects(retryAgentRun({runId: run.id, actor: admin.login, requestId: randomUUID()}), /비활성 앱/);
  assert.equal((await prisma.agentRun.findUniqueOrThrow({where: {id: run.id}})).status, "DEAD_LETTER");
  assert.equal(await prisma.agentRunEvent.count({where: {runId: run.id, type: "manual_retry"}}), 0);
});

test("작업 등록이 먼저 완료되면 앱 숨김을 거부하고 실행 대기를 보존한다", async () => {
  const {app, admin, hide} = await fixture();
  await createOperatorCommand({sourceInteractionId: randomUUID(), appId: app.id,
    operation: "qa.no-external-execution", actorDiscordUserId: admin.login, channelId: "qa"});
  await assert.rejects(hide(), /진행 중/);
  assert.equal((await prisma.app.findUniqueOrThrow({where: {id: app.id}})).status, "ACTIVE");
  assert.equal(await prisma.auditLog.count({where: {entityId: app.id, action: "app.visibility"}}), 0);
});

test("앱 잠금을 보유한 등록 트랜잭션 뒤 숨김은 새 실행 대기를 확인한다", async () => {
  const {app, hide} = await fixture();
  let acquired!: () => void;
  let resume!: () => void;
  const locked = new Promise<void>((resolve) => { acquired = resolve; });
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  const enqueue = prisma.$transaction(async (tx) => {
    await lockAppForNewWork(tx, app.id);
    acquired();
    await resumed;
    await tx.appOperationRun.create({data: {
      appId: app.id, repoFullName: app.repoFullName, operation: "qa.readback", intent: "read",
      requestId: randomUUID(), expiresAt: new Date(Date.now() + 60000),
    }});
  });
  await locked;
  const hiding = hide();
  const rejected = assert.rejects(hiding, /진행 중/);
  resume();
  await enqueue;
  await rejected;
  assert.equal((await prisma.app.findUniqueOrThrow({where: {id: app.id}})).status, "ACTIVE");
  assert.equal(await prisma.appOperationRun.count({where: {appId: app.id}}), 1);
});

test("숨김 후 분석 작업을 등록하지 않고 공급자 관측의 별도 이력을 보존한다", async () => {
  const {app, hide} = await fixture();
  const observation = await prisma.sourceCollectionRun.create({data: {
    appId: app.id, source: "qa", target: app.slug, status: "observed", completedAt: new Date(),
  }});
  await hide();
  await assert.rejects(publishSignal({
    dedupeKey: app.id, appId: app.id, kind: "review-change", title: "격리 관측",
    facts: [{id: "rating", label: "평점", value: "2점", source: "격리 QA"}], sourceRefs: [], observedAt: new Date(),
  }), /비활성 앱/);
  assert.equal(await prisma.agentRun.count({where: {appId: app.id}}), 0);
  assert.equal(await prisma.operationalSignal.count({where: {dedupeKey: app.id}}), 0);
  assert.deepEqual(await prisma.sourceCollectionRun.findUniqueOrThrow({where: {id: observation.id}}), observation);
});

after(() => prisma.$disconnect());
