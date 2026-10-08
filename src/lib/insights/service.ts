import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";
import { enqueueNotification, requeueNotification } from "@/lib/notifications/outbox";
import {
  discordDestinationOrFallback,
  type DiscordDestinationKey,
} from "@/lib/notifications/destinations";
import { env } from "@/lib/env";
import { metricDayOf, metricDayStart, shiftMetricDay } from "@/lib/analytics/metric-day";
import {
  evidenceListSchema,
  validatedEvidence,
  insightInputHash,
  INSIGHT_PROMPT_VERSION,
  personaForKind,
  renderInsight,
  type Evidence,
} from "./contract";
import { generateInsight } from "./generate";

export const ANALYSIS_TEMPLATE = "operations-insights-api-v1";
const policy = {
  schemaVersion: 1,
  approvalPolicy: "READ_ONLY",
  createsPr: false,
  claimSource: "operational-signal",
  budgetCeilingMicros: 1_000_000,
};
const json = (value: unknown) => value as Prisma.InputJsonValue;
async function serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (attempt >= 3 || !["P2034", "P2002"].includes((error as { code?: string }).code ?? ""))
        throw error;
    }
  }
}
function destination(kind: string, severity: string): DiscordDestinationKey {
  if (severity === "critical" || /failure|recovery|stale/.test(kind)) return "ops-alerts";
  if (/review/.test(kind)) return "user-reviews";
  if (/release|submission|published|public-listing/.test(kind)) return "release-ops";
  if (/keyword|competitor|policy/.test(kind)) return "metrics-daily";
  return "app-ops";
}
function safeText(value: string) {
  return value.replace(/[@<>`]/g, "").slice(0, 160);
}
function notificationPayload(
  signal: { title: string; kind: string; severity: string; facts: unknown; observedAt: Date },
  insightId: string,
  content?: string,
) {
  const facts = evidenceListSchema.parse(signal.facts);
  return {
    text: `**${safeText(signal.title)}**\n${
      content ??
      facts
        .slice(0, 5)
        .map((fact) => `- ${safeText(fact.label)} ${safeText(fact.value)} 관측됨`)
        .join("\n")
    }\n[근거·다음 행동](${env.optional("AUTH_URL") || "https://backoffice.vzyx.xyz"}/feedback/insights/${insightId})`,
    editable: true,
    sender: "seori",
    insightId,
    ...(/metric-weekly/.test(signal.kind)
      ? {
          chart: "org-trend",
          refDate: shiftMetricDay(metricDayOf(signal.observedAt), -1),
          weekly: true,
        }
      : {}),
    embed: {
      title: "운영 인사이트",
      color: signal.severity === "critical" ? 0xdc2626 : 0x2563eb,
      footer: `관측 ${signal.observedAt.toISOString()} · ${signal.kind}`,
    },
  };
}

/** 신호·분석 occurrence·사실 알림을 함께 저장한다. GitHub mutation capability는 부여하지 않는다. */
export async function publishSignal(input: {
  dedupeKey: string;
  appId?: string | null;
  kind: string;
  severity?: string;
  title: string;
  facts: Evidence[];
  sourceRefs: Array<{ label: string; url: string }>;
  observedAt: Date;
}) {
  const facts = validatedEvidence(input.facts);
  return serializable(async (tx) => {
    const signal = await tx.operationalSignal.upsert({
      where: { dedupeKey: input.dedupeKey },
      create: {
        ...input,
        severity: input.severity ?? "info",
        facts: json(facts),
        sourceRefs: json(input.sourceRefs),
      },
      update: {},
    });
    const inputHash = insightInputHash(evidenceListSchema.parse(signal.facts));
    const existing = await tx.insightDocument.findUnique({
      where: { signalId_inputHash: { signalId: signal.id, inputHash } },
    });
    if (existing) return existing;
    const document = await tx.insightDocument.create({
      data: {
        signalId: signal.id,
        inputHash,
        persona: personaForKind(signal.kind),
        promptVersion: INSIGHT_PROMPT_VERSION,
        status: "PENDING",
        notificationKey: `insight:${signal.id}`,
      },
    });
    const definition = await tx.automationDefinition.upsert({
      where: { key: ANALYSIS_TEMPLATE },
      create: {
        key: ANALYSIS_TEMPLATE,
        template: ANALYSIS_TEMPLATE,
        agentKind: "API",
        model: env.minimaxChatModel(),
        configuration: policy,
      },
      update: {},
    });
    const latest = await tx.automationOccurrence.findFirst({
      where: { definitionId: definition.id },
      orderBy: { scheduledFor: "desc" },
      select: { scheduledFor: true },
    });
    const occurrence = await tx.automationOccurrence.create({
      data: {
        definitionId: definition.id,
        scheduledFor: new Date(Math.max(Date.now(), (latest?.scheduledFor.getTime() ?? 0) + 1)),
        idempotencyKey: `insight:${document.id}`,
        triggerKind: "OPERATIONAL_SIGNAL",
        triggerKey: `insight:${document.id}`,
      },
    });
    const app = input.appId
      ? await tx.app.findUnique({ where: { id: input.appId }, select: { repoFullName: true } })
      : null;
    const run = await tx.agentRun.create({
      data: {
        occurrenceId: occurrence.id,
        appId: input.appId,
        repoFullName: app?.repoFullName ?? "seorilabs/seorilabs-backoffice",
        createsPr: false,
        labels: [],
        taskInput: { insightId: document.id, inputHash },
        workKey: `insight:${document.id}`,
        priority: input.severity === "critical" ? 1 : 100,
        maxAttempts: 3,
      },
    });
    await tx.insightDocument.update({ where: { id: document.id }, data: { runId: run.id } });
    await tx.agentRunEvent.create({
      data: {
        runId: run.id,
        type: "INSIGHT_QUEUED",
        actor: "internal:operations-insights",
        payload: { insightId: document.id, inputHash, approvalPolicy: "READ_ONLY" },
      },
    });
    await enqueueNotification(
      {
        dedupeKey: document.notificationKey,
        kind: "OPS_ALERT",
        payload: notificationPayload(signal, document.id),
        destinations: discordDestinationOrFallback(
          destination(signal.kind, signal.severity),
          "backoffice",
        ),
      },
      tx,
    );
    return document;
  });
}

async function claim(workerId: string) {
  return serializable(async (tx) => {
    const now = new Date();
    // API worker의 lease만 회수한다. 다른 Codex/Claude run·repo guard를 건드리지 않는다.
    const expired = await tx.agentLease.findMany({
      where: { workerId: { startsWith: "insights:" }, revokedAt: null, expiresAt: { lte: now } },
      select: { id: true, runId: true, generation: true },
    });
    for (const lease of expired) {
      await tx.agentLease.update({
        where: { id: lease.id },
        data: { revokedAt: now, scopeKey: null },
      });
      const run = await tx.agentRun.findUniqueOrThrow({ where: { id: lease.runId } });
      await tx.agentRun.updateMany({
        where: { id: run.id, status: "RUNNING", leaseGeneration: lease.generation },
        data: {
          status: run.attempts < run.maxAttempts ? "PENDING" : "DEAD_LETTER",
          error: "ANALYSIS_LEASE_EXPIRED",
        },
      });
      if (run.attempts >= run.maxAttempts) {
        await tx.insightDocument.updateMany({
          where: { runId: run.id, status: "PENDING" },
          data: { status: "FAILED", errorCode: "ANALYSIS_LEASE_EXPIRED" },
        });
        await tx.automationOccurrence.update({
          where: { id: run.occurrenceId },
          data: { status: "DEAD_LETTER", completedAt: now },
        });
      }
    }
    const occupied = await tx.agentLease.findMany({
      where: {
        scopeKey: { in: ["api-insight:0", "api-insight:1"] },
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { scopeKey: true },
    });
    const slot = ["api-insight:0", "api-insight:1"].find(
      (key) => !occupied.some((lease) => lease.scopeKey === key),
    );
    if (!slot) return null;
    const run = await tx.agentRun.findFirst({
      where: {
        status: "PENDING",
        cancelledAt: null,
        eligibleAt: { lte: now },
        occurrence: {
          definition: {
            template: ANALYSIS_TEMPLATE,
            agentKind: "API",
            enabled: true,
            pausedAt: null,
            cancelledAt: null,
          },
        },
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      include: { occurrence: { include: { definition: true } } },
    });
    if (
      !run ||
      run.createsPr ||
      canonicalJson(run.occurrence.definition.configuration as JsonValue) !== canonicalJson(policy)
    )
      return null;
    const generation = run.leaseGeneration + 1;
    if (
      (
        await tx.agentRun.updateMany({
          where: { id: run.id, status: "PENDING", leaseGeneration: run.leaseGeneration },
          data: {
            status: "RUNNING",
            leaseGeneration: generation,
            attempts: { increment: 1 },
            startedAt: now,
          },
        })
      ).count !== 1
    )
      return null;
    const lease = await tx.agentLease.create({
      data: {
        runId: run.id,
        generation,
        workerId,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        scopeKey: slot,
        expiresAt: new Date(now.getTime() + 8 * 60_000),
        heartbeatAt: now,
      },
    });
    await tx.automationOccurrence.update({
      where: { id: run.occurrenceId },
      data: { status: "RUNNING" },
    });
    await tx.agentRunEvent.create({
      data: {
        runId: run.id,
        type: "INSIGHT_CLAIMED",
        actor: workerId,
        generation,
        payload: {
          capabilities: ["operational-signal.read", "insight.generate"],
          createsPr: false,
        },
      },
    });
    return { run, lease };
  });
}
async function reserveRequest(runId: string, generation: number, workerId: string) {
  return serializable(async (tx) => {
    const day = metricDayOf(new Date());
    const limit = Number(process.env.INSIGHTS_DAILY_LIMIT ?? 200);
    const count = await tx.agentRunEvent.count({
      where: {
        type: "INSIGHT_API_REQUEST",
        createdAt: { gte: metricDayStart(day), lt: metricDayStart(shiftMetricDay(day, 1)) },
      },
    });
    if (count >= (Number.isSafeInteger(limit) && limit >= 0 ? limit : 200)) return false;
    const owned = await tx.agentLease.count({
      where: { runId, generation, workerId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!owned) return false;
    await tx.agentRunEvent.create({
      data: { runId, generation, type: "INSIGHT_API_REQUEST", actor: workerId },
    });
    return true;
  });
}
export async function processNextInsight(
  workerId = `insights:${process.env.INSIGHTS_WORKER_ID ?? "local"}:${process.pid}`,
  generate = generateInsight,
): Promise<boolean> {
  if (!workerId.startsWith("insights:")) throw new Error("INVALID_INSIGHT_WORKER_ID");
  const claimed = await claim(workerId);
  if (!claimed) return false;
  const document = await prisma.insightDocument.findUniqueOrThrow({
    where: { runId: claimed.run.id },
    include: { signal: true },
  });
  const facts = evidenceListSchema.parse(document.signal.facts);
  const made = await generate(facts, personaForKind(document.signal.kind), {
    reserve: () => reserveRequest(claimed.run.id, claimed.lease.generation, workerId),
  });
  await serializable(async (tx) => {
    const now = new Date();
    const owned = await tx.agentLease.count({
      where: {
        id: claimed.lease.id,
        workerId,
        generation: claimed.lease.generation,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (!owned || document.inputHash !== insightInputHash(facts))
      throw new Error("STALE_INSIGHT_COMPLETION");
    const updated = await tx.agentRun.updateMany({
      where: {
        id: claimed.run.id,
        status: "RUNNING",
        cancelledAt: null,
        leaseGeneration: claimed.lease.generation,
      },
      data: {
        status: "SUCCEEDED",
        completedAt: now,
        outcome: { insightId: document.id, fallback: made.fallback },
      },
    });
    if (!updated.count) throw new Error("STALE_INSIGHT_COMPLETION");
    await tx.insightDocument.update({
      where: { id: document.id },
      data: {
        status: made.fallback ? "FALLBACK" : "READY",
        model: made.fallback ? null : env.minimaxChatModel(),
        content: json(made.content),
        errorCode: made.errorCode,
        completedAt: now,
      },
    });
    await tx.agentLease.update({
      where: { id: claimed.lease.id },
      data: { revokedAt: now, scopeKey: null },
    });
    await tx.automationOccurrence.update({
      where: { id: claimed.run.occurrenceId },
      data: {
        status: "COMPLETED",
        completedAt: now,
        result: { insightId: document.id, fallback: made.fallback },
      },
    });
    await tx.agentRunEvent.create({
      data: {
        runId: claimed.run.id,
        type: "INSIGHT_COMPLETED",
        actor: workerId,
        generation: claimed.lease.generation,
        payload: {
          inputHash: document.inputHash,
          fallback: made.fallback,
          errorCode: made.errorCode,
        },
      },
    });
    const eventId = await enqueueNotification(
      {
        dedupeKey: document.notificationKey,
        kind: "OPS_ALERT",
        payload: notificationPayload(
          document.signal,
          document.id,
          renderInsight(made.content, facts),
        ),
        destinations: [],
      },
      tx,
    );
    await requeueNotification(eventId, tx);
  });
  return true;
}
