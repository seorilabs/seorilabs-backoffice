import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { publishSignal, processNextInsight } from "@/lib/insights/service";
import { fallbackInsight } from "@/lib/insights/contract";
import { acquireAnalysisPermit, releaseAnalysisPermit } from "@/lib/insights/budget";
import { requeueExpiredLeases } from "@/lib/control-plane/agent-queue";
import { drainNotifications, requeueNotification } from "@/lib/notifications/outbox";
import { submissionSignal } from "@/lib/insights/triggers";
const url = new URL(process.env.DATABASE_URL ?? "");
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  !/^\/backoffice_(qa|empty_contract_test|cutover_contract_test)$/.test(url.pathname)
)
  throw new Error("ISOLATED_DATABASE_REQUIRED");
async function main() {
  const input = {
    dedupeKey: "qa-signal-" + Date.now(),
    kind: "metric-change",
    title: "격리 QA 변화",
    facts: [{ id: "active", label: "관측", value: "7명", source: "격리 QA" }],
    observedAt: new Date(),
    sourceRefs: [],
  };
  const items = await Promise.all([publishSignal(input), publishSignal(input)]);
  assert.equal(items[0].id, items[1].id);
  const stored = await prisma.insightDocument.findUniqueOrThrow({ where: { id: items[0].id } });
  assert.equal(await prisma.agentRun.count({ where: { workKey: "insight:" + stored.id } }), 1);
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: stored.runId! } });
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "RUNNING", attempts: 3, leaseGeneration: 1 },
  });
  const expired = await prisma.agentLease.create({
    data: {
      runId: run.id,
      generation: 1,
      workerId: "insights:qa-expired",
      tokenHash: "a".repeat(64),
      scopeKey: "api-insight:0",
      expiresAt: new Date(Date.now() - 1000),
      heartbeatAt: new Date(),
    },
  });
  await requeueExpiredLeases(new Date());
  assert.equal(
    (await prisma.agentLease.findUniqueOrThrow({ where: { id: expired.id } })).revokedAt,
    null,
  );
  await processNextInsight("insights:qa-recover");
  assert.equal(
    (await prisma.insightDocument.findUniqueOrThrow({ where: { id: items[0].id } })).status,
    "FAILED",
  );
  const next = await publishSignal({ ...input, dedupeKey: input.dedupeKey + "-next" });
  await processNextInsight("insights:qa-analysis", async (facts) => ({
    content: fallbackInsight(facts),
    fallback: true,
    errorCode: "QA_FALLBACK",
  }));
  const nextDoc = await prisma.insightDocument.findUniqueOrThrow({ where: { id: next.id } });
  assert.equal(nextDoc.status, "FALLBACK");
  const event = await prisma.notificationEvent.findUniqueOrThrow({
    where: { dedupeKey: next.notificationKey },
  });
  const delivery = await prisma.notificationDelivery.create({
    data: {
      eventId: event.id,
      provider: "DISCORD",
      destinationKey: "qa",
      status: "PENDING",
      refreshRequested: null,
      providerMessageId: "qa-edit",
    },
  });
  let start!: () => void, finish!: () => void;
  const entered = new Promise<void>((r) => {
      start = r;
    }),
    gate = new Promise<void>((r) => {
      finish = r;
    });
  const draining = drainNotifications(100, async () => {
    start();
    await gate;
    return { ok: true, messageId: "qa-edit" };
  });
  await entered;
  await prisma.$transaction(async (tx) => {
    await tx.notificationEvent.update({
      where: { id: event.id },
      data: { payload: { text: "최신 분석", editable: true } },
    });
    await requeueNotification(event.id, tx);
  });
  assert.equal(
    (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
      .refreshRequested,
    true,
  );
  finish();
  await draining;
  assert.equal(
    (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    "PENDING",
  );
  await drainNotifications(100, async ({ payload, providerMessageId }) => {
    assert.equal((payload as { text: string }).text, "최신 분석");
    assert.equal(providerMessageId, "qa-edit");
    return { ok: true, messageId: providerMessageId! };
  });
  assert.equal(
    (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    "SENT",
  );
  const permits = await Promise.all([
    acquireAnalysisPermit(),
    acquireAnalysisPermit(),
    acquireAnalysisPermit(),
  ]);
  assert.equal(permits.filter(Boolean).length, 2);
  await Promise.all(permits.filter((id): id is string => id !== null).map(releaseAnalysisPermit));
  process.env.INSIGHTS_DAILY_LIMIT = "0";
  assert.equal(await acquireAnalysisPermit(), null);
  delete process.env.INSIGHTS_DAILY_LIMIT;
  assert.equal(submissionSignal("PENDING_APPLE_RELEASE", null), null);
  assert.equal(submissionSignal("READY_FOR_DISTRIBUTION", null), "submission-approved");
  assert.equal(submissionSignal("play:v2:PUBLISHED:completed:", "internal"), null);
  assert.equal(submissionSignal("play:v2:PUBLISHED:completed:", "production"), "published");
  console.log(
    "operations acceptance: dedupe, API lease ownership, grounded fallback, editable delivery race, concurrency, daily ceiling, public evidence OK",
  );
}
main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
