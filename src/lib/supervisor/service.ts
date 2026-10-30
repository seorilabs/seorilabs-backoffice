import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { lockAppForNewWork } from "@/lib/control-plane/app-work-lock";
import { CHANNEL_SUPERVISOR } from "@/lib/notifications/destinations";
import { supervisorSlackChannelId } from "./channel";
import {
  ensure,
  digest,
  proposalSchema,
  observationSchema,
  targetSchema,
  type ProposalInput,
  type ReportInput,
} from "./contracts";
import {
  eligibility,
  canDecide,
  canReport,
  dayKey,
  afterNine,
  rankCandidates,
} from "./policy";

type Tx = Prisma.TransactionClient;
const LEASE_MS = 120000;
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
async function lock(tx: Tx) {
  await tx.$executeRaw`INSERT INTO work_coordinator (id,mode,updatedAt) VALUES (1,'OBSERVE',NOW(3)) ON DUPLICATE KEY UPDATE updatedAt=updatedAt`;
  return tx.workCoordinator.findUniqueOrThrow({ where: { id: 1 } });
}
async function event(
  tx: Tx,
  kind: string,
  actor: string,
  details: unknown,
  proposalId?: string,
  runId?: string,
  id: string = randomUUID(),
) {
  return tx.workEvent.create({
    data: { id, kind, actor, details: json(details), proposalId, runId },
  });
}
export async function registerTarget(raw: unknown) {
  const input = targetSchema.parse(raw);
  if (input.kind === "APP") {
    ensure(input.repository && input.policySha, "TARGET_POLICY_REQUIRED");
    const { loadRegistrationPolicy } =
      await import("@/lib/metric-issues/policy");
    const policy = await loadRegistrationPolicy(true);
    ensure(
      policy.sha === input.policySha &&
        policy.data.repositories.some(
          (r) =>
            r.repository === input.repository && r.registration === "ENABLED",
        ),
      "TARGET_EXCLUDED",
    );
    const app = await prisma.app.findFirst({
      where: { repoFullName: input.repository, status: "ACTIVE" },
      select: { id: true },
    });
    ensure(app && app.id === input.appId, "TARGET_APP_UNAVAILABLE");
  }
  return prisma.$transaction(async (tx) => {
    await lock(tx);
    return tx.workTarget.upsert({
      where: { id: input.id },
      create: input,
      update: input,
    });
  });
}
export async function submitObservations(raw: unknown[]) {
  const inputs = raw.map((value) => observationSchema.parse(value));
  ensure(inputs.length <= 100, "OBSERVATION_LIMIT", 400);
  return prisma.$transaction(async (tx) => {
    const coordinator = await lock(tx);
    ensure(coordinator.mode !== "PAUSED", "SUPERVISOR_PAUSED");
    for (const input of inputs) {
      ensure(
        Date.parse(input.observedAt) <= Date.now() + 60000,
        "OBSERVATION_FUTURE",
        400,
      );
      ensure(
        await tx.workTarget.findFirst({
          where: { id: input.targetId, enabled: true },
        }),
        "TARGET_UNAVAILABLE",
      );
      const old = await tx.workObservation.findUnique({
        where: { id: input.id },
      });
      if (old) {
        ensure(
          digest({
            ...input,
            observedAt: new Date(input.observedAt),
            expiresAt: new Date(input.expiresAt),
            waitUntil: input.waitUntil ? new Date(input.waitUntil) : null,
          }) ===
            digest(
              Object.fromEntries(
                Object.entries(old).filter(([key]) => key !== "createdAt"),
              ),
            ),
          "OBSERVATION_ID_CONFLICT",
        );
        continue;
      }
      await tx.workObservation.create({
        data: {
          ...input,
          observedAt: new Date(input.observedAt),
          expiresAt: new Date(input.expiresAt),
          waitUntil: input.waitUntil ? new Date(input.waitUntil) : null,
        },
      });
    }
    return { accepted: inputs.length };
  });
}
async function validateEvidence(tx: Tx, p: ProposalInput, now: Date) {
  const observations = await tx.workObservation.findMany({
    where: { id: { in: p.observationIds }, targetId: p.targetId },
  });
  ensure(
    observations.length === new Set(p.observationIds).size,
    "EVIDENCE_MISSING",
  );
  const groups = new Set<string>();
  for (const observation of observations) {
    // 로컬 상태는 여러 문서와 코드 문제를 발견하는 공통 근거이며 문제 자체가 아니다.
    ensure(
      observation.source === "local" || observation.problemKey === p.problemKey,
      "EVIDENCE_PROBLEM_MISMATCH",
    );
    ensure(!eligibility(observation, now), "EVIDENCE_NOT_READY");
    groups.add(observation.problemKey);
  }
  for (const problemKey of groups) {
    const latest = await tx.workObservation.findFirst({
      where: { targetId: p.targetId, problemKey },
      orderBy: { observedAt: "desc" },
    });
    ensure(latest && !eligibility(latest, now), "LATEST_EVIDENCE_NOT_READY");
  }
}
export async function createProposal(raw: unknown, actor: string) {
  const input = proposalSchema.parse(raw),
    hash = digest(input),
    now = new Date();
  return prisma.$transaction(async (tx) => {
    const coordinator = await lock(tx);
    ensure(coordinator.mode !== "PAUSED", "SUPERVISOR_PAUSED");
    const target = await tx.workTarget.findFirst({
      where: { id: input.targetId, enabled: true },
    });
    ensure(target, "TARGET_UNAVAILABLE");
    await validateEvidence(tx, input, now);
    const old = await tx.workProposal.findFirst({
      where: { targetId: input.targetId, problemKey: input.problemKey },
      orderBy: { version: "desc" },
    });
    if (
      old?.digest === hash &&
      !(old.status === "SNOOZED" && old.snoozedUntil && old.snoozedUntil <= now)
    )
      return old;
    ensure(
      !old || !["APPROVED", "EXCLUDED", "COMPLETED"].includes(old.status),
      "PROBLEM_ALREADY_HANDLED",
    );
    ensure(!old?.snoozedUntil || old.snoozedUntil <= now, "PROBLEM_SNOOZED");
    if (old)
      await tx.workProposal.update({
        where: { id: old.id },
        data: { status: "SUPERSEDED" },
      });
    const proposal = await tx.workProposal.create({
      data: {
        targetId: input.targetId,
        problemKey: input.problemKey,
        title: input.title,
        version: (old?.version ?? 0) + 1,
        payload: json(input),
        digest: hash,
      },
    });
    await event(
      tx,
      "PROPOSED",
      actor,
      { version: proposal.version, digest: hash },
      proposal.id,
    );
    return proposal;
  });
}
async function assertCurrentTargetPolicy(targetId: string) {
  const target = await prisma.workTarget.findUniqueOrThrow({
    where: { id: targetId },
  });
  ensure(target.enabled, "TARGET_UNAVAILABLE");
  if (target.kind === "APP") {
    const { loadRegistrationPolicy } =
      await import("@/lib/metric-issues/policy");
    const policy = await loadRegistrationPolicy(true);
    ensure(
      policy.data.repositories.some(
        (r) =>
          r.repository === target.repository && r.registration === "ENABLED",
      ),
      "TARGET_EXCLUDED",
    );
  }
}
export async function decideProposal(
  input: {
    id: string;
    version: number;
    digest: string;
    decision: "approve" | "snooze" | "exclude" | "cancel" | "reconcile";
    evidence?: string[];
    actor: string;
  },
  now = new Date(),
) {
  if (input.decision === "approve") {
    const proposal = await prisma.workProposal.findUniqueOrThrow({
      where: { id: input.id },
    });
    await assertCurrentTargetPolicy(proposal.targetId);
  }
  return prisma.$transaction(async (tx) => {
    await lock(tx);
    const p = await tx.workProposal.findUniqueOrThrow({
      where: { id: input.id },
      include: { target: true },
    });
    ensure(p.target.enabled, "TARGET_UNAVAILABLE");
    ensure(
      p.version === input.version && p.digest === input.digest,
      "PROPOSAL_VERSION_CHANGED",
    );
    const latest = await tx.workProposal.findFirst({
      where: { targetId: p.targetId, problemKey: p.problemKey },
      orderBy: { version: "desc" },
    });
    ensure(latest?.id === p.id, "PROPOSAL_SUPERSEDED");
    if (input.decision === "approve" && p.status === "APPROVED") return p;
    if (input.decision === "reconcile") {
      ensure(
        p.runId && input.evidence?.length,
        "RECONCILIATION_EVIDENCE_REQUIRED",
      );
      const run = await tx.operatorCommandRun.findUniqueOrThrow({
        where: { id: p.runId },
      });
      ensure(
        run.localState === "PAUSED" &&
          (run.checkpoint as Record<string, unknown>)?.processStopped === true,
        "PROCESS_STOP_REQUIRED",
      );
      await tx.operatorCommandRun.update({
        where: { id: run.id },
        data: {
          status: run.status === "CANCELLED" ? "CANCELLED" : "FAILED",
          localState: "STOPPED",
          leaseUntil: null,
          completedAt: now,
        },
      });
      await tx.workCoordinator.updateMany({
        where: { id: 1, activeRunId: run.id },
        data: { activeRunId: null },
      });
      await event(
        tx,
        "RECONCILED",
        input.actor,
        { evidence: input.evidence },
        p.id,
        run.id,
      );
      return p;
    }
    if (input.decision === "cancel") {
      ensure(p.status === "APPROVED" && p.runId, "NOT_RUNNING");
      const run = await tx.operatorCommandRun.findUniqueOrThrow({
        where: { id: p.runId },
      });
      ensure(
        ["PENDING", "PROCESSING"].includes(run.status),
        "RUN_ALREADY_TERMINAL",
      );
      await tx.operatorCommandRun.update({
        where: { id: run.id },
        data: {
          status: "CANCELLED",
          localState: run.status === "PENDING" ? "STOPPED" : "STOP_REQUESTED",
          completedAt: now,
        },
      });
      if (run.status === "PENDING")
        await tx.workCoordinator.updateMany({
          where: { id: 1, activeRunId: run.id },
          data: { activeRunId: null },
        });
      await event(
        tx,
        "CANCELLED",
        input.actor,
        { version: p.version, digest: p.digest },
        p.id,
        run.id,
      );
      return tx.workProposal.update({
        where: { id: p.id },
        data: { status: "CANCELLED" },
      });
    }
    ensure(
      canDecide(p, input.version, input.digest, now),
      "PROPOSAL_NOT_READY",
    );
    const payload = proposalSchema.parse(p.payload);
    if (input.decision === "approve") await validateEvidence(tx, payload, now);
    const status =
      input.decision === "approve"
        ? "APPROVED"
        : input.decision === "snooze"
          ? "SNOOZED"
          : "EXCLUDED";
    let runId: string | undefined;
    if (status === "APPROVED") {
      const channelId = supervisorSlackChannelId();
      ensure(channelId, "SUPERVISOR_SLACK_CHANNEL_NOT_CONFIGURED", 503);
      if (p.target.appId) await lockAppForNewWork(tx, p.target.appId);
      const run = await tx.operatorCommandRun.create({
        data: {
          sourceProvider: "SLACK",
          sourceInteractionId: `supervisor:${p.id}:${p.version}`,
          appId: p.target.appId,
          operation: "supervisor_execute",
          executionLocation: "LOCAL",
          actorUserId: input.actor,
          actorLabel: input.actor,
          channelId,
          status: "PENDING",
          confirmedAt: now,
          expiresAt: new Date(now.getTime() + 7 * 86400000),
          localState: "QUEUED",
          params: { proposalId: p.id, version: p.version, digest: p.digest },
        },
      });
      runId = run.id;
    }
    await event(
      tx,
      status,
      input.actor,
      { version: p.version, digest: p.digest },
      p.id,
      runId,
    );
    return tx.workProposal.update({
      where: { id: p.id },
      data: {
        status,
        decidedBy: input.actor,
        decidedAt: now,
        runId,
        snoozedUntil:
          status === "SNOOZED" ? new Date(now.getTime() + 7 * 86400000) : null,
      },
    });
  });
}
export async function claimRun(
  owner: string,
  now = new Date(),
  requestId: string = randomUUID(),
) {
  const pending = await prisma.operatorCommandRun.findFirst({
    where: {
      executionLocation: "LOCAL",
      status: "PENDING",
      expiresAt: { gt: now },
      workProposal: { status: "APPROVED" },
    },
    orderBy: { createdAt: "asc" },
    include: { workProposal: true },
  });
  if (pending?.workProposal)
    await assertCurrentTargetPolicy(pending.workProposal.targetId);
  return prisma.$transaction(async (tx) => {
    const coordinator = await lock(tx);
    const previous = await tx.workEvent.findUnique({
      where: { id: `claim:${requestId}` },
    });
    if (previous) {
      ensure(previous.actor === owner && previous.runId, "CLAIM_ID_CONFLICT");
      const run = await tx.operatorCommandRun.findUniqueOrThrow({
        where: { id: previous.runId },
        include: { workProposal: { include: { target: true } } },
      });
      ensure(run.executionOwner === owner, "RUN_OWNERSHIP_LOST");
      return coordinator.mode === "ACTIVE" &&
        canReport(run, owner, run.generation!, now) &&
        run.localState === "RUNNING"
        ? { run, active: null }
        : { run: null, active: run };
    }
    const expired = await tx.operatorCommandRun.findMany({
      where: {
        executionLocation: "LOCAL",
        operation: "supervisor_execute",
        status: "PENDING",
        expiresAt: { lte: now },
      },
      include: { workProposal: true },
      take: 100,
    });
    for (const run of expired) {
      await tx.operatorCommandRun.update({
        where: { id: run.id },
        data: {
          status: "EXPIRED",
          localState: "STOPPED",
          completedAt: now,
          summary: "승인 후 실행 대기 기한이 지나 새 검토가 필요합니다.",
        },
      });
      if (run.workProposal)
        await tx.workProposal.update({
          where: { id: run.workProposal.id },
          data: { status: "BLOCKED" },
        });
      await event(
        tx,
        "PENDING_EXPIRED",
        owner,
        {},
        run.workProposal?.id,
        run.id,
      );
    }
    ensure(coordinator.mode === "ACTIVE", "SUPERVISOR_NOT_ACTIVE");
    if (coordinator.activeRunId) {
      const active = await tx.operatorCommandRun.findUniqueOrThrow({
        where: { id: coordinator.activeRunId },
        include: { workProposal: { include: { target: true } } },
      });
      if (
        active.leaseUntil &&
        active.leaseUntil <= now &&
        active.localState === "RUNNING"
      ) {
        await tx.operatorCommandRun.update({
          where: { id: active.id },
          data: { localState: "UNCERTAIN" },
        });
        await event(
          tx,
          "LEASE_EXPIRED",
          owner,
          { generation: active.generation },
          active.workProposal?.id,
          active.id,
        );
      }
      return { run: null, active };
    }
    const candidate = await tx.operatorCommandRun.findFirst({
      where: {
        executionLocation: "LOCAL",
        operation: "supervisor_execute",
        status: "PENDING",
        expiresAt: { gt: now },
        workProposal: { status: "APPROVED", target: { enabled: true } },
      },
      orderBy: { createdAt: "asc" },
      include: { workProposal: { include: { target: true } } },
    });
    if (!candidate) return { run: null, active: null };
    const p = proposalSchema.parse(candidate.workProposal!.payload);
    await validateEvidence(tx, p, now);
    if (candidate.appId) await lockAppForNewWork(tx, candidate.appId);
    const generation = (candidate.generation ?? 0) + 1;
    const run = await tx.operatorCommandRun.update({
      where: { id: candidate.id },
      data: {
        status: "PROCESSING",
        executionOwner: owner,
        generation,
        checkpoint: { claimRequestId: requestId },
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        localState: "RUNNING",
        startedAt: now,
        attempts: { increment: 1 },
      },
      include: { workProposal: { include: { target: true } } },
    });
    await tx.workCoordinator.update({
      where: { id: 1 },
      data: { activeRunId: run.id },
    });
    await event(
      tx,
      "CLAIMED",
      owner,
      { generation, requestId },
      candidate.workProposal!.id,
      run.id,
      `claim:${requestId}`,
    );
    return { run, active: null };
  });
}
export async function reportRun(
  runId: string,
  owner: string,
  input: ReportInput,
  now = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    const coordinator = await lock(tx);
    const old = await tx.workEvent.findUnique({
      where: { id: input.requestId },
    });
    const fingerprint = digest(input);
    if (old) {
      ensure(
        old.runId === runId &&
          old.actor === owner &&
          (old.details as Record<string, unknown>).fingerprint === fingerprint,
        "REPORT_ID_CONFLICT",
      );
      return { accepted: true, duplicate: true };
    }
    const run = await tx.operatorCommandRun.findUniqueOrThrow({
      where: { id: runId },
      include: { workProposal: true },
    });
    ensure(
      run.executionLocation === "LOCAL" &&
        run.executionOwner === owner &&
        run.generation === input.generation &&
        coordinator.activeRunId === runId,
      "RUN_OWNERSHIP_LOST",
    );
    // 만료와 취소 후에는 프로세스 중단과 현재 상태 확인만 기록한다.
    const stopped = input.kind === "stopped";
    if (stopped) {
      ensure(
        input.checkpoint.processStopped === true &&
          input.checkpoint.readbackVerified === true &&
          input.evidence.length > 0,
        "STOP_READBACK_REQUIRED",
      );
    } else if (input.kind === "paused") {
      ensure(input.checkpoint.processStopped === true, "PROCESS_STOP_REQUIRED");
    } else
      ensure(
        canReport(run, owner, input.generation, now) &&
          run.localState === "RUNNING",
        "RUN_LEASE_LOST",
      );
    const previous = run.checkpoint as Record<string, unknown> | null;
    ensure(
      !previous?.sessionId ||
        !input.sessionId ||
        previous.sessionId === input.sessionId,
      "SESSION_CHANGED",
    );
    if (input.kind === "succeeded")
      ensure(
        input.sessionId !== null &&
          input.evidence.length > 0 &&
          input.checkpoint.testsPassed === true &&
          input.checkpoint.readbackVerified === true,
        "COMPLETION_EVIDENCE_REQUIRED",
      );
    const finished = stopped || input.kind === "succeeded";
    if (input.kind === "paused")
      ensure(input.checkpoint.processStopped === true, "PROCESS_STOP_REQUIRED");
    await tx.operatorCommandRun.update({
      where: { id: runId },
      data: {
        leaseUntil:
          finished || input.kind === "paused"
            ? null
            : new Date(now.getTime() + LEASE_MS),
        checkpoint: json({
          ...input.checkpoint,
          sessionId: input.sessionId ?? previous?.sessionId ?? null,
          evidence: input.evidence,
        }),
        summary: input.summary,
        ...(input.kind === "paused" ? { localState: "PAUSED" } : {}),
        ...(finished
          ? {
              status:
                run.status === "CANCELLED"
                  ? "CANCELLED"
                  : input.kind === "succeeded"
                    ? "SUCCEEDED"
                    : "FAILED",
              localState:
                input.kind === "succeeded"
                  ? "COMPLETED"
                  : stopped
                    ? "STOPPED"
                    : "PAUSED",
              completedAt: now,
            }
          : {}),
      },
    });
    await event(
      tx,
      input.kind.toUpperCase(),
      owner,
      { fingerprint, ...input },
      run.workProposal?.id,
      runId,
      input.requestId,
    );
    if (input.kind === "succeeded" || input.kind === "paused")
      await enqueueNotification(
        {
          dedupeKey: `supervisor-result:${runId}:${input.requestId}`,
          kind: "EXTERNAL_FEED",
          payload: {
            text: `**${input.kind === "succeeded" ? "작업 완료 확인" : "작업 확인 필요"}: ${run.workProposal?.title || "대표 작업"}**\n${input.summary}\n[진행과 근거 보기](${process.env.AUTH_URL || "https://backoffice.vzyx.xyz"}/work/supervisor?id=${run.workProposal?.id})`,
            source: "personal-supervisor",
            externalId: input.requestId,
          },
          destinations: [{ provider: "SLACK", key: CHANNEL_SUPERVISOR }],
        },
        tx,
      );
    if (input.kind === "paused" && run.workProposal)
      await tx.workProposal.update({
        where: { id: run.workProposal.id },
        data: { status: run.status === "CANCELLED" ? "CANCELLED" : "BLOCKED" },
      });
    if (finished) {
      await tx.workCoordinator.update({
        where: { id: 1 },
        data: { activeRunId: null },
      });
      if (run.workProposal)
        await tx.workProposal.update({
          where: { id: run.workProposal.id },
          data: {
            status:
              run.status === "CANCELLED"
                ? "CANCELLED"
                : input.kind === "succeeded"
                  ? "COMPLETED"
                  : "BLOCKED",
          },
        });
    }
    return { accepted: true, duplicate: false };
  });
}
export async function beginAnalysis(owner: string, now = new Date()) {
  if (!afterNine(now)) return null;
  return prisma.$transaction(async (tx) => {
    const c = await lock(tx);
    if (c.mode === "PAUSED") return null;
    const day = dayKey(now);
    if (await tx.workAnalysis.findUnique({ where: { day } })) return null;
    return tx.workAnalysis.create({
      data: {
        day,
        owner,
        startedAt: now,
        deadline: new Date(now.getTime() + 30 * 60000),
      },
    });
  });
}
export async function finishAnalysis(owner: string, day: string) {
  return prisma.workAnalysis.updateMany({
    where: { day, owner, completedAt: null },
    data: { completedAt: new Date() },
  });
}
export async function setMode(
  mode: "OBSERVE" | "ACTIVE" | "PAUSED",
  actor: string,
) {
  return prisma.$transaction(async (tx) => {
    await lock(tx);
    await event(tx, "MODE_CHANGED", actor, { mode });
    return tx.workCoordinator.update({ where: { id: 1 }, data: { mode } });
  });
}
export async function listProposals() {
  return prisma.workProposal.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { target: true, run: true },
  });
}
export async function supervisorSnapshot() {
  const [targets, proposals, state, recent] = await Promise.all([
    prisma.workTarget.findMany(),
    listProposals(),
    prisma.workCoordinator.findUnique({ where: { id: 1 } }),
    prisma.workObservation.findMany({
      where: { expiresAt: { gt: new Date() } },
      orderBy: { observedAt: "desc" },
      take: 300,
    }),
  ]);
  const ids = proposals.flatMap(
    (p) => proposalSchema.parse(p.payload).observationIds,
  );
  const bound = await prisma.workObservation.findMany({
    where: { id: { in: ids } },
  });
  const observations = [
    ...new Map([...recent, ...bound].map((o) => [o.id, o])).values(),
  ];
  return {
    now: new Date().toISOString(),
    targets,
    proposals,
    state: state ?? { mode: "OBSERVE", activeRunId: null },
    observations,
  };
}
export async function reservePublications(now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const c = await lock(tx);
    if (c.mode !== "ACTIVE" || !afterNine(now)) return [];
    const day = dayKey(now),
      count = await tx.workProposal.count({ where: { publicationDay: day } });
    const candidates = await tx.workProposal.findMany({
      where: {
        status: { in: ["READY", "SNOOZED"] },
        publicationDay: null,
        target: { enabled: true },
        OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
      },
      orderBy: { createdAt: "asc" },
      take: 30,
    });
    const selected = [];
    const eligible = [];
    for (const p of candidates) {
      try {
        await validateEvidence(tx, proposalSchema.parse(p.payload), now);
      } catch {
        continue;
      }
      eligible.push({ ...p, ...proposalSchema.parse(p.payload) });
    }
    for (const p of rankCandidates(eligible, new Set(), now)) {
      if (selected.length >= 3 - count) break;
      await tx.workProposal.update({
        where: { id: p.id },
        data: { publicationDay: day, deliveryState: "STARTED" },
      });
      selected.push(p);
    }
    return selected;
  });
}
