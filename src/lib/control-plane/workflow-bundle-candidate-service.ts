import { Prisma } from "@prisma/client";

import {
  WORKFLOW_BUNDLE_CANDIDATE_AUTOMATION_POLICY,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
  eligibleForAutopilot,
} from "@/lib/control-plane/automation-catalog";
import {
  claimTrustedExecutorRun,
  settleAgentRun,
  type ClaimedAgentRun,
} from "@/lib/control-plane/agent-queue";
import { beginAutomationMutation, completeAutomationMutation } from "@/lib/control-plane/automation-mutation";
import {
  readCallerBootstrapInstallationGate,
  type CallerBootstrapGate,
} from "@/lib/control-plane/github-installation-gate";
import { canonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { repositoryAutomationEligible } from "@/lib/control-plane/repository-registration";
import { ControlPlaneError, resolveManifest } from "@/lib/control-plane/service";
import {
  buildWorkflowBundleCandidateTask,
  publicWorkflowBundleCandidateTask,
  workflowBundleCandidateTaskSchema,
  type WorkflowBundleCandidateTask,
} from "@/lib/control-plane/workflow-bundle-candidate-contract";
import { verifyWorkflowBundleRegistryReadback } from "@/lib/control-plane/workflow-bundle-v5-registry";
import { prisma } from "@/lib/prisma";

const DEFINITION_KEY = "workflow-bundle-candidate-executor-v1:trusted";
const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 300;

export type WorkflowBundleCandidateGate = CallerBootstrapGate;

export interface WorkflowBundleCandidatePlan {
  mode: "PLAN";
  planDigest: string;
  task: ReturnType<typeof publicWorkflowBundleCandidateTask>;
  gate: WorkflowBundleCandidateGate;
  mutationAttempted: false;
}

function definitionPolicyMatches(value: unknown): boolean {
  return canonicalJson(value as JsonValue)
    === canonicalJson(WORKFLOW_BUNDLE_CANDIDATE_AUTOMATION_POLICY as unknown as JsonValue);
}

async function requireDefinition() {
  let definition = await prisma.automationDefinition.findUnique({ where: { key: DEFINITION_KEY } });
  if (!definition) {
    try {
      definition = await prisma.automationDefinition.create({
        data: {
          key: DEFINITION_KEY,
          template: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
          schedule: null,
          agentKind: null,
          model: null,
          configuration: WORKFLOW_BUNDLE_CANDIDATE_AUTOMATION_POLICY,
          enabled: true,
          maxAttempts: MAX_ATTEMPTS,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      definition = await prisma.automationDefinition.findUnique({ where: { key: DEFINITION_KEY } });
    }
  }
  if (
    !definition
    || definition.template !== WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY
    || definition.schedule !== null
    || definition.agentKind !== null
    || definition.model !== null
    || !definition.enabled
    || definition.pausedAt !== null
    || definition.cancelledAt !== null
    || definition.maxAttempts !== MAX_ATTEMPTS
    || !definitionPolicyMatches(definition.configuration)
  ) {
    throw new ControlPlaneError(
      "WorkflowBundle candidate executor definition이 exact 정책과 다릅니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_DEFINITION_MISMATCH",
    );
  }
  return definition;
}

async function loadTask(input: {
  workflowBundleRecordId: string;
  repositoryId: string;
  sourceSha: string;
  issueNumber: number | null;
}): Promise<{ task: WorkflowBundleCandidateTask; gate: WorkflowBundleCandidateGate; appId: string }> {
  const repoId = BigInt(input.repositoryId);
  const [registration, app, record] = await Promise.all([
    prisma.repositoryRegistration.findUnique({ where: { repoId } }),
    prisma.app.findUnique({ where: { repoId } }),
    prisma.workflowBundleRegistryRecord.findUnique({ where: { id: input.workflowBundleRecordId } }),
  ]);
  if (
    !repositoryAutomationEligible(registration)
    || registration?.classification !== "PRODUCT_APP"
    || registration.repoId !== repoId
    || registration.lastDefaultPushSha?.toLowerCase() !== input.sourceSha.toLowerCase()
    || !registration.defaultBranch
  ) {
    throw new ControlPlaneError(
      "candidate repository가 현재 MANAGED PRODUCT_APP exact source가 아닙니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_REPOSITORY_MISMATCH",
    );
  }
  if (
    !app
    || app.status !== "ACTIVE"
    || app.repoId !== repoId
    || app.repoFullName.toLowerCase() !== registration.repoFullName.toLowerCase()
  ) {
    throw new ControlPlaneError(
      "candidate repository의 ACTIVE App binding이 일치하지 않습니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_APP_MISMATCH",
    );
  }
  if (!record || record.approvalState !== "CANDIDATE") {
    throw new ControlPlaneError(
      "exact WorkflowBundle candidate registry record가 없습니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_RECORD_MISSING",
    );
  }
  verifyWorkflowBundleRegistryReadback(
    record,
    process.env.WORKFLOW_BUNDLE_V5_APPROVAL_PUBLIC_KEYS_JSON ?? "",
  );
  const installation = await readCallerBootstrapInstallationGate(app.id);
  if (input.issueNumber !== null) {
    const issue = await prisma.issueMirror.findUnique({
      where: { repoFullName_number: { repoFullName: app.repoFullName, number: input.issueNumber } },
      select: { number: true, state: true, labels: true },
    });
    if (!issue || !eligibleForAutopilot({
      issueNumber: issue.number,
      issueState: issue.state,
      labels: issue.labels,
    })) {
      throw new ControlPlaneError(
        "candidate issue가 현재 autopilot 대상이 아닙니다.",
        409,
        "WORKFLOW_BUNDLE_CANDIDATE_ISSUE_INELIGIBLE",
      );
    }
  }
  const resolved = await resolveManifest({
    repoId,
    sourceSha: input.sourceSha.toLowerCase(),
    signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
  });
  const task = buildWorkflowBundleCandidateTask({
    record,
    resolved: { ...resolved, app: { ...resolved.app, status: app.status } },
    repositoryId: input.repositoryId,
    fullName: app.repoFullName,
    sourceSha: input.sourceSha.toLowerCase(),
    defaultBranch: registration.defaultBranch,
    issueNumber: input.issueNumber,
    installationId: installation.installationId,
  });
  return { task, gate: installation.gate, appId: app.id };
}

export async function planWorkflowBundleCandidateExecution(input: {
  workflowBundleRecordId: string;
  repositoryId: string;
  sourceSha: string;
  issueNumber: number | null;
}): Promise<WorkflowBundleCandidatePlan> {
  const loaded = await loadTask(input);
  return {
    mode: "PLAN",
    planDigest: loaded.task.planDigest,
    task: publicWorkflowBundleCandidateTask(loaded.task),
    gate: loaded.gate,
    mutationAttempted: false,
  };
}

export async function enqueueWorkflowBundleCandidateExecution(input: {
  workflowBundleRecordId: string;
  repositoryId: string;
  sourceSha: string;
  issueNumber: number | null;
  actor: string;
  idempotencyKey: string;
}) {
  const request = {
    mode: "ENQUEUE",
    workflowBundleRecordId: input.workflowBundleRecordId,
    repositoryId: input.repositoryId,
    sourceSha: input.sourceSha.toLowerCase(),
    issueNumber: input.issueNumber,
  } as const;
  const mutation = {
    requestId: input.idempotencyKey,
    actor: input.actor,
    operation: "workflow-bundle.candidate.enqueue",
    targetKey: `repository:${input.repositoryId}`,
    request: request as unknown as JsonValue,
  };
  const begun = await beginAutomationMutation(mutation);
  if (begun.replay) return { ...begun.replay as Record<string, unknown>, duplicate: true };
  const loaded = await loadTask(input);
  if (loaded.gate.state !== "READY") {
    throw new ControlPlaneError(
      "GitHub App에 candidate Ready PR 최소 권한이 없습니다.",
      409,
      loaded.gate.code,
    );
  }
  const definition = await requireDefinition();
  const triggerKey = `workflow-bundle-candidate:${loaded.task.planDigest}`;
  let occurrence = await prisma.automationOccurrence.findUnique({
    where: { triggerKey },
    include: { runs: true },
  });
  if (!occurrence) {
    const issue = input.issueNumber === null
      ? null
      : await prisma.issueMirror.findUnique({
          where: {
            repoFullName_number: {
              repoFullName: loaded.task.repository.fullName,
              number: input.issueNumber,
            },
          },
          select: { state: true, labels: true, priority: true },
        });
    try {
      occurrence = await prisma.automationOccurrence.create({
        data: {
          definitionId: definition.id,
          scheduledFor: new Date(),
          idempotencyKey: jsonDigest({ definitionId: definition.id, triggerKey } as JsonValue),
          triggerKind: "CONTROL_PLANE",
          triggerKey,
          status: "PENDING",
          result: {
            schemaVersion: 1,
            planDigest: loaded.task.planDigest,
            candidateRecordId: loaded.task.candidate.recordId,
            repositoryId: loaded.task.repository.id,
            sourceSha: loaded.task.repository.sourceSha,
            mutationAttempted: false,
          },
          runs: {
            create: {
              appId: loaded.appId,
              repoFullName: loaded.task.repository.fullName,
              issueNumber: loaded.task.repository.issueNumber,
              workKey: `workflow-bundle-candidate:${loaded.task.planDigest}`,
              issueState: issue?.state ?? null,
              labels: (Array.isArray(issue?.labels) ? issue.labels : []) as Prisma.InputJsonValue,
              taskInput: loaded.task as unknown as Prisma.InputJsonValue,
              createsPr: true,
              priority: issue?.priority === "P1"
                ? 1
                : issue?.priority === "P2"
                  ? 2
                  : issue?.priority === "P3"
                    ? 3
                    : issue?.priority === "P4"
                      ? 4
                      : 1,
              maxAttempts: MAX_ATTEMPTS,
            },
          },
        },
        include: { runs: true },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      occurrence = await prisma.automationOccurrence.findUnique({
        where: { triggerKey },
        include: { runs: true },
      });
    }
  }
  const run = occurrence?.runs[0];
  if (
    !occurrence
    || occurrence.definitionId !== definition.id
    || occurrence.runs.length !== 1
    || !run
    || run.repoFullName !== loaded.task.repository.fullName
    || workflowBundleCandidateTaskSchema.parse(run.taskInput).planDigest !== loaded.task.planDigest
  ) {
    throw new ControlPlaneError(
      "candidate occurrence replay binding이 다릅니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_OCCURRENCE_MISMATCH",
    );
  }
  const result = {
    mode: "ENQUEUE" as const,
    occurrenceId: occurrence.id,
    runId: run.id,
    runStatus: run.status,
    planDigest: loaded.task.planDigest,
    gate: loaded.gate,
    duplicate: false,
    mutationAttempted: false,
  };
  return completeAutomationMutation({
    ...mutation,
    requestHash: begun.requestHash,
    response: result,
    audit: {
      action: "workflow-bundle.candidate.enqueued",
      entityType: "AgentRun",
      entityId: run.id,
      payload: {
        planDigest: loaded.task.planDigest,
        candidateRecordId: loaded.task.candidate.recordId,
        repositoryId: loaded.task.repository.id,
        sourceSha: loaded.task.repository.sourceSha,
        mutationAttempted: false,
      },
    },
  });
}

export async function assertWorkflowBundleCandidateTaskCurrent(
  rawTask: unknown,
): Promise<WorkflowBundleCandidateTask> {
  const task = workflowBundleCandidateTaskSchema.parse(rawTask);
  const current = await loadTask({
    workflowBundleRecordId: task.candidate.recordId,
    repositoryId: task.repository.id,
    sourceSha: task.repository.sourceSha,
    issueNumber: task.repository.issueNumber,
  });
  if (
    current.gate.state !== "READY"
    || canonicalJson(current.task as unknown as JsonValue) !== canonicalJson(task as unknown as JsonValue)
  ) {
    throw new ControlPlaneError(
      "candidate task의 registry/config/source/provider binding이 더 이상 현재가 아닙니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_TASK_STALE",
    );
  }
  return task;
}

export async function readWorkflowBundleCandidateOidcBinding(input: {
  repositoryId: string;
  sourceSha: string;
  workflowBundleSha: string;
}) {
  const repoId = BigInt(input.repositoryId);
  const app = await prisma.app.findUnique({
    where: { repoId },
    select: { repoFullName: true },
  });
  if (!app) {
    throw new ControlPlaneError(
      "candidate OIDC repository binding이 없습니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_OIDC_PLAN_MISSING",
    );
  }
  const runs = await prisma.agentRun.findMany({
    where: {
      repoFullName: app.repoFullName,
      status: { in: ["RUNNING", "SUCCEEDED", "FAILED"] },
      occurrence: {
        definition: { template: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY },
      },
    },
    include: { repoGuard: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
  });
  const matches: Array<{ runId: string; task: WorkflowBundleCandidateTask }> = [];
  for (const run of runs) {
    const parsed = workflowBundleCandidateTaskSchema.safeParse(run.taskInput);
    if (
      !parsed.success
      || parsed.data.repository.id !== input.repositoryId
      || parsed.data.repository.sourceSha !== input.sourceSha.toLowerCase()
      || parsed.data.candidate.sourceSha !== input.workflowBundleSha.toLowerCase()
      || run.repoGuard?.activeScopeKey !== `repo-pr:${app.repoFullName.toLowerCase()}`
      || (run.status === "FAILED" && !run.readbackRequestedAt)
    ) continue;
    try {
      await assertWorkflowBundleCandidateTaskCurrent(parsed.data);
      matches.push({ runId: run.id, task: parsed.data });
    } catch {
      // stale signed tasks cannot authorize a current canary OIDC request
    }
  }
  if (matches.length !== 1) {
    throw new ControlPlaneError(
      matches.length === 0
        ? "현재 candidate OIDC plan을 찾을 수 없습니다."
        : "candidate OIDC plan이 둘 이상이라 exact branch를 고를 수 없습니다.",
      409,
      matches.length === 0
        ? "WORKFLOW_BUNDLE_CANDIDATE_OIDC_PLAN_MISSING"
        : "WORKFLOW_BUNDLE_CANDIDATE_OIDC_PLAN_AMBIGUOUS",
    );
  }
  const match = matches[0]!;
  return {
    runId: match.runId,
    planDigest: match.task.planDigest,
    expectedHeadRef: match.task.github.expectedHeadRef.replace(/^refs\/heads\//u, ""),
  };
}

export async function claimNextWorkflowBundleCandidate(input: {
  runtimeBindingDigest: string;
  idempotencyKey: string;
}): Promise<(ClaimedAgentRun & { task: WorkflowBundleCandidateTask }) | null> {
  const pending = await prisma.agentRun.findMany({
    where: {
      OR: [{ status: "PENDING" }, { status: "FAILED", readbackRequestedAt: { not: null } }],
      occurrence: { definition: { template: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY } },
    },
    select: { id: true, status: true, readbackRequestedAt: true, taskInput: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: 10,
  });
  if (pending.length === 0) return null;
  const viable: Array<{ runId: string; planDigest: string }> = [];
  for (const run of pending) {
    const task = workflowBundleCandidateTaskSchema.safeParse(run.taskInput);
    if (!task.success) continue;
    if (run.status === "FAILED" && run.readbackRequestedAt) {
      viable.push({ runId: run.id, planDigest: task.data.planDigest });
      continue;
    }
    try {
      await assertWorkflowBundleCandidateTaskCurrent(task.data);
      viable.push({ runId: run.id, planDigest: task.data.planDigest });
    } catch {
      // stale plan stays fail-closed and cannot be claimed for a write
    }
  }
  if (viable.length === 0) return null;
  const claimed = await claimTrustedExecutorRun({
    gate: "workflow-bundle-candidate",
    template: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
    workerId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    runtimeBindingDigest: input.runtimeBindingDigest,
    leaseSeconds: LEASE_SECONDS,
    idempotencyKey: input.idempotencyKey,
    runId: viable[0].runId,
  });
  if (!claimed) return null;
  const task = workflowBundleCandidateTaskSchema.parse(claimed.taskInput);
  if (!viable.some((entry) => entry.runId === claimed.runId && entry.planDigest === task.planDigest)) {
    await settleAgentRun({
      sessionId: claimed.sessionId,
      workerId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
      runtimeBindingDigest: input.runtimeBindingDigest,
      outcome: "fail",
      error: "WORKFLOW_BUNDLE_CANDIDATE_TASK_STALE",
      result: {
        outcomeCode: "BLOCKED",
        summary: "candidate task current binding이 claim 직전에 변경되었습니다.",
        costMicros: 0,
      },
      idempotencyKey: `candidate-stale:${claimed.runId}:g${claimed.generation}`,
    });
    return null;
  }
  if (claimed.resumeMode === "START") await assertWorkflowBundleCandidateTaskCurrent(task);
  return { ...claimed, task };
}

export async function readWorkflowBundleCandidateRun(runId: string) {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: {
      occurrence: { select: { status: true, triggerKey: true } },
      events: { orderBy: { createdAt: "desc" }, take: 20 },
      repoGuard: true,
    },
  });
  if (!run) throw new ControlPlaneError("candidate run이 없습니다.", 404, "WORKFLOW_BUNDLE_CANDIDATE_RUN_NOT_FOUND");
  const task = workflowBundleCandidateTaskSchema.parse(run.taskInput);
  return {
    runId: run.id,
    status: run.status,
    occurrenceStatus: run.occurrence.status,
    planDigest: task.planDigest,
    candidate: task.candidate,
    repository: task.repository,
    attempts: run.attempts,
    generation: run.leaseGeneration,
    readbackRequired: run.readbackRequestedAt !== null,
    repoGuardActive: run.repoGuard?.activeScopeKey !== null && run.repoGuard?.activeScopeKey !== undefined,
    outcome: run.outcome,
    error: run.error,
    events: run.events.map((event) => ({
      type: event.type,
      generation: event.generation,
      actor: event.actor,
      createdAt: event.createdAt,
    })),
  };
}
