import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import {
  APPROVED_CALLER_RECONCILIATION_AUTOMATION_POLICY,
  APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
  APPROVED_CALLER_RECONCILIATION_EXECUTOR_TEMPLATE_KEY,
} from "@/lib/control-plane/automation-catalog";
import {
  claimTrustedExecutorRun,
  settleAgentRun,
  type ClaimedAgentRun,
} from "@/lib/control-plane/agent-queue";
import {
  beginAutomationMutation,
  completeAutomationMutation,
} from "@/lib/control-plane/automation-mutation";
import {
  planApprovedCallerReconciliation,
  type ApprovedCallerReconciliationPlan,
  type CallerReconciliationVerdict,
} from "@/lib/control-plane/approved-caller-reconciler";
import {
  approvedCallerReconciliationTaskSchema,
  buildApprovedCallerReconciliationTask,
  publicApprovedCallerReconciliationTask,
  type ApprovedCallerReconciliationTask,
} from "@/lib/control-plane/approved-caller-reconciliation-contract";
import {
  readCallerBootstrapInstallationGate,
  type CallerBootstrapGate,
} from "@/lib/control-plane/github-installation-gate";
import { canonicalJson, contractCanonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { verifyApprovedBundle } from "@/lib/control-plane/workflow-bundle-v5-registry";
import { prisma } from "@/lib/prisma";

const DEFINITION_KEY = "approved-caller-reconciliation-executor-v1:trusted";
const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 300;

function planOptions() {
  return {
    signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
    snapshotSignatureKeyId: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_ID ?? "",
    snapshotSignaturePolicyRevision:
      process.env.CONTROL_PLANE_SNAPSHOT_SIGNATURE_POLICY_REVISION ?? "",
  };
}

function trustedApprovalKeysJson(): string {
  return process.env.WORKFLOW_BUNDLE_V5_APPROVAL_PUBLIC_KEYS_JSON ?? "";
}

export async function planApprovedCallerReconciliationForRepository(
  repositoryId: string,
): Promise<{ plan: ApprovedCallerReconciliationPlan; verdict: CallerReconciliationVerdict }> {
  const plan = await planApprovedCallerReconciliation(
    { ...planOptions(), repositoryId },
    undefined,
    { trustedApprovalKeysJson: trustedApprovalKeysJson() },
  );
  const verdict = plan.verdicts[0];
  if (plan.verdicts.length !== 1 || !verdict) {
    throw new ControlPlaneError(
      "caller 반증 대상 저장소를 하나로 특정할 수 없습니다.",
      409,
      "APPROVED_CALLER_TARGET_NOT_EXACT",
    );
  }
  return { plan, verdict };
}

async function loadTask(repositoryId: string): Promise<{
  task: ApprovedCallerReconciliationTask;
  gate: CallerBootstrapGate;
  appId: string;
  repoFullName: string;
}> {
  const { plan, verdict } = await planApprovedCallerReconciliationForRepository(repositoryId);
  if (verdict.state !== "ELIGIBLE") {
    throw new ControlPlaneError(
      "caller 반증 대상이 현재 적격이 아닙니다.",
      409,
      verdict.reasonCode,
    );
  }
  const app = await prisma.app.findUnique({
    where: { repoId: BigInt(repositoryId) },
    select: { id: true, repoFullName: true },
  });
  if (!app || app.repoFullName !== verdict.fullName) {
    throw new ControlPlaneError(
      "caller 반증 대상 App binding이 계획과 다릅니다.",
      409,
      "APPROVED_CALLER_APP_MISMATCH",
    );
  }
  const installation = await readCallerBootstrapInstallationGate(app.id);
  const task = buildApprovedCallerReconciliationTask({
    approvedBundle: {
      registryRecordId: plan.approvedBundle.registryRecordId,
      sourceSha: plan.approvedBundle.sourceSha,
      payloadDigest: plan.approvedBundle.payloadDigest,
      approvalKeyId: plan.approvedBundle.approvalKeyId,
      bundle: plan.approvedBundle.bundle,
    },
    repositoryId: verdict.repositoryId,
    fullName: verdict.fullName,
    sourceSha: verdict.sourceSha,
    sourceRef: verdict.sourceRef,
    defaultBranch: verdict.defaultBranch,
    callerPath: verdict.callerPath,
    resolvedManifest: verdict.resolvedManifest,
    installationId: installation.installationId,
  });
  return { task, gate: installation.gate, appId: app.id, repoFullName: app.repoFullName };
}

function definitionPolicyMatches(value: unknown): boolean {
  return canonicalJson(value as JsonValue)
    === canonicalJson(APPROVED_CALLER_RECONCILIATION_AUTOMATION_POLICY as unknown as JsonValue);
}

async function requireDefinition() {
  let definition = await prisma.automationDefinition.findUnique({ where: { key: DEFINITION_KEY } });
  if (!definition) {
    try {
      definition = await prisma.automationDefinition.create({
        data: {
          key: DEFINITION_KEY,
          template: APPROVED_CALLER_RECONCILIATION_EXECUTOR_TEMPLATE_KEY,
          schedule: null,
          agentKind: null,
          model: null,
          configuration: APPROVED_CALLER_RECONCILIATION_AUTOMATION_POLICY,
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
    || definition.template !== APPROVED_CALLER_RECONCILIATION_EXECUTOR_TEMPLATE_KEY
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
      "caller 반증기 definition이 exact 정책과 다릅니다.",
      409,
      "APPROVED_CALLER_DEFINITION_MISMATCH",
    );
  }
  return definition;
}

export async function planApprovedCallerReconciliationExecution(repositoryId: string) {
  const loaded = await loadTask(repositoryId);
  return {
    mode: "PLAN" as const,
    planDigest: loaded.task.planDigest,
    task: publicApprovedCallerReconciliationTask(loaded.task),
    gate: loaded.gate,
    mutationAttempted: false as const,
  };
}

export async function enqueueApprovedCallerReconciliation(input: {
  repositoryId: string;
  actor: string;
  idempotencyKey: string;
}) {
  const mutation = {
    requestId: input.idempotencyKey,
    actor: input.actor,
    operation: "workflow-bundle.approved-caller.enqueue",
    targetKey: `repository:${input.repositoryId}`,
    request: { mode: "ENQUEUE", repositoryId: input.repositoryId } as unknown as JsonValue,
  };
  const begun = await beginAutomationMutation(mutation);
  if (begun.replay) return { ...begun.replay as Record<string, unknown>, duplicate: true };
  const loaded = await loadTask(input.repositoryId);
  if (loaded.gate.state !== "READY") {
    throw new ControlPlaneError(
      "GitHub App에 caller Ready PR 최소 권한이 없습니다.",
      409,
      loaded.gate.code,
    );
  }
  const definition = await requireDefinition();
  const triggerKey = `approved-caller:${loaded.task.planDigest}`;
  let occurrence = await prisma.automationOccurrence.findUnique({
    where: { triggerKey },
    include: { runs: true },
  });
  if (!occurrence) {
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
            approvedBundleRecordId: loaded.task.approvedBundle.registryRecordId,
            repositoryId: loaded.task.repository.id,
            sourceSha: loaded.task.repository.sourceSha,
            mutationAttempted: false,
          },
          runs: {
            create: {
              appId: loaded.appId,
              repoFullName: loaded.task.repository.fullName,
              issueNumber: null,
              workKey: `approved-caller:${loaded.task.planDigest}`,
              issueState: null,
              labels: [] as Prisma.InputJsonValue,
              taskInput: loaded.task as unknown as Prisma.InputJsonValue,
              createsPr: true,
              priority: 1,
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
    || approvedCallerReconciliationTaskSchema.parse(run.taskInput).planDigest
      !== loaded.task.planDigest
  ) {
    throw new ControlPlaneError(
      "caller 반증 occurrence replay binding이 다릅니다.",
      409,
      "APPROVED_CALLER_OCCURRENCE_MISMATCH",
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
      action: "workflow-bundle.approved-caller.enqueued",
      entityType: "AgentRun",
      entityId: run.id,
      payload: {
        planDigest: loaded.task.planDigest,
        approvedBundleRecordId: loaded.task.approvedBundle.registryRecordId,
        repositoryId: loaded.task.repository.id,
        sourceSha: loaded.task.repository.sourceSha,
        mutationAttempted: false,
      },
    },
  });
}

/**
 * claim/step마다 계획을 다시 만들어 exact 비교한다. 승인 번들, ACTIVE 설정, discovery,
 * installation 중 하나라도 움직이면 같은 task가 나오지 않으므로 write가 멈춘다.
 */
export async function assertApprovedCallerReconciliationTaskCurrent(
  rawTask: unknown,
): Promise<ApprovedCallerReconciliationTask> {
  const task = approvedCallerReconciliationTaskSchema.parse(rawTask);
  const current = await loadTask(task.repository.id);
  if (
    current.gate.state !== "READY"
    || canonicalJson(current.task as unknown as JsonValue)
      !== canonicalJson(task as unknown as JsonValue)
  ) {
    throw new ControlPlaneError(
      "caller 반증 task의 승인 번들/설정/source binding이 더 이상 현재가 아닙니다.",
      409,
      "APPROVED_CALLER_TASK_STALE",
    );
  }
  return task;
}

export async function claimNextApprovedCallerReconciliation(input: {
  runtimeBindingDigest: string;
  idempotencyKey: string;
}): Promise<(ClaimedAgentRun & { task: ApprovedCallerReconciliationTask }) | null> {
  const pending = await prisma.agentRun.findMany({
    where: {
      OR: [{ status: "PENDING" }, { status: "FAILED", readbackRequestedAt: { not: null } }],
      occurrence: {
        definition: { template: APPROVED_CALLER_RECONCILIATION_EXECUTOR_TEMPLATE_KEY },
      },
    },
    select: { id: true, status: true, readbackRequestedAt: true, taskInput: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: 10,
  });
  const viable: Array<{ runId: string; planDigest: string }> = [];
  for (const run of pending) {
    const task = approvedCallerReconciliationTaskSchema.safeParse(run.taskInput);
    if (!task.success) continue;
    if (run.status === "FAILED" && run.readbackRequestedAt) {
      viable.push({ runId: run.id, planDigest: task.data.planDigest });
      continue;
    }
    try {
      await assertApprovedCallerReconciliationTaskCurrent(task.data);
      viable.push({ runId: run.id, planDigest: task.data.planDigest });
    } catch {
      // 낡은 계획은 fail-closed로 남기고 write를 위해 claim하지 않는다
    }
  }
  if (viable.length === 0) return null;
  const claimed = await claimTrustedExecutorRun({
    gate: "approved-caller-reconciliation",
    template: APPROVED_CALLER_RECONCILIATION_EXECUTOR_TEMPLATE_KEY,
    workerId: APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
    runtimeBindingDigest: input.runtimeBindingDigest,
    leaseSeconds: LEASE_SECONDS,
    idempotencyKey: input.idempotencyKey,
    runId: viable[0]!.runId,
  });
  if (!claimed) return null;
  const task = approvedCallerReconciliationTaskSchema.parse(claimed.taskInput);
  if (!viable.some((entry) => entry.runId === claimed.runId && entry.planDigest === task.planDigest)) {
    await settleAgentRun({
      sessionId: claimed.sessionId,
      workerId: APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
      runtimeBindingDigest: input.runtimeBindingDigest,
      outcome: "fail",
      error: "APPROVED_CALLER_TASK_STALE",
      result: {
        outcomeCode: "BLOCKED",
        summary: "caller 반증 task binding이 claim 직전에 변경되었습니다.",
        costMicros: 0,
      },
      idempotencyKey: `approved-caller-stale:${claimed.runId}:g${claimed.generation}`,
    });
    return null;
  }
  if (claimed.resumeMode === "START") await assertApprovedCallerReconciliationTaskCurrent(task);
  return { ...claimed, task };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 실행기는 승인 서명 trust root를 갖지 않는다. 계약이 요구하는 검증 결과를 중앙이 자기
 * registry 사본으로 만들고, 실행기가 계산한 digest와 전부 일치할 때만 VERIFIED를 준다.
 */
export function verifyApprovedCallerBundle(input: {
  task: ApprovedCallerReconciliationTask;
  candidateDigest: string;
  payloadDigest: string;
  approvalPayloadDigest: string;
  contractDigestsDigest: string;
  runtimeAssetDigestsDigest: string;
  evidenceDigest: string;
}) {
  const verified = verifyApprovedBundle(input.task.approvedBundle.bundle, trustedApprovalKeysJson());
  const source = verified.approved.source as { sha: string; workflowExecutionSha: string };
  const expected = {
    candidateDigest: verified.candidate.integrity.payloadDigest,
    payloadDigest: verified.approved.integrity.payloadDigest,
    approvalPayloadDigest: verified.approvalPayloadDigest,
    contractDigestsDigest: `sha256:${sha256Hex(
      contractCanonicalJson(verified.approved.quality.contractDigests as unknown as JsonValue),
    )}`,
    runtimeAssetDigestsDigest: `sha256:${sha256Hex(
      contractCanonicalJson(verified.approved.quality.runtimeAssetDigests as unknown as JsonValue),
    )}`,
    evidenceDigest: `sha256:${sha256Hex(
      contractCanonicalJson(verified.approved.approval.evidence as unknown as JsonValue),
    )}`,
  };
  if (
    input.candidateDigest !== expected.candidateDigest
    || input.payloadDigest !== expected.payloadDigest
    || input.approvalPayloadDigest !== expected.approvalPayloadDigest
    || input.contractDigestsDigest !== expected.contractDigestsDigest
    || input.runtimeAssetDigestsDigest !== expected.runtimeAssetDigestsDigest
    || input.evidenceDigest !== expected.evidenceDigest
    || expected.payloadDigest !== input.task.approvedBundle.payloadDigest
    || source.sha !== input.task.approvedBundle.sourceSha
  ) {
    throw new ControlPlaneError(
      "실행기가 계산한 승인 번들 digest가 중앙 registry 사본과 다릅니다.",
      409,
      "APPROVED_CALLER_BUNDLE_DIGEST_MISMATCH",
    );
  }
  return {
    state: "VERIFIED" as const,
    ...expected,
    sourceSha: source.sha,
    workflowExecutionSha: source.workflowExecutionSha,
    keyId: verified.approved.approval.signature.keyId,
    policyRevision: verified.approved.approval.signature.policyRevision,
  };
}
