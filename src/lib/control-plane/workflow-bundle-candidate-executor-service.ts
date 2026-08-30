import {
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
} from "@/lib/control-plane/automation-catalog";
import {
  heartbeatAgentRun,
  resolveAgentRunReadback,
  settleAgentRun,
} from "@/lib/control-plane/agent-queue";
import {
  authorizeGithubReadyPrMutation,
  claimGithubMutationRecovery,
  claimGithubMutationStep,
  completeGithubMutationStep,
  planGithubCommitMutationStep,
  recordGithubMutationReadback,
} from "@/lib/control-plane/agent-mutation-service";
import {
  agentGithubMutationStepObservationSchema,
  agentGithubObservationSchema,
} from "@/lib/control-plane/contracts";
import { jsonDigest } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import {
  assertWorkflowBundleCandidateTaskCurrent,
  claimNextWorkflowBundleCandidate,
} from "@/lib/control-plane/workflow-bundle-candidate-service";
import { workflowBundleCandidateTaskSchema } from "@/lib/control-plane/workflow-bundle-candidate-contract";
import { prisma } from "@/lib/prisma";

export function workflowBundleCandidateRuntimeBindingDigest(input: {
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
}): string {
  return jsonDigest({
    schemaVersion: 1,
    principal: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
    workload: "workflow-bundle-candidate-executor",
  });
}

async function sessionTask(input: {
  sessionId: string;
  runtimeBindingDigest: string;
  requireCurrent: boolean;
}) {
  const session = await prisma.agentWorkerSession.findUnique({
    where: { id: input.sessionId },
    include: {
      lease: {
        include: {
          run: { include: { occurrence: { include: { definition: true } } } },
        },
      },
    },
  });
  if (
    !session
    || session.principalId !== WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL
    || session.runtimeBindingDigest !== input.runtimeBindingDigest
    || session.lease.workerId !== WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL
    || session.lease.run.occurrence.definition.template !== WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY
    || session.lease.run.occurrence.definition.agentKind !== null
  ) {
    throw new ControlPlaneError(
      "candidate executor session binding이 일치하지 않습니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_SESSION_MISMATCH",
    );
  }
  const task = workflowBundleCandidateTaskSchema.parse(session.lease.run.taskInput);
  if (input.requireCurrent) await assertWorkflowBundleCandidateTaskCurrent(task);
  return { session, task };
}

type AdapterIdentity = {
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  runtimeBindingDigest: string;
  idempotencyKey: string;
};

export async function claimCandidateExecutor(identity: AdapterIdentity) {
  const claimed = await claimNextWorkflowBundleCandidate({
    runtimeBindingDigest: identity.runtimeBindingDigest,
    idempotencyKey: identity.idempotencyKey,
  });
  if (!claimed) return null;
  return {
    sessionId: claimed.sessionId,
    runId: claimed.runId,
    generation: claimed.generation,
    resumeMode: claimed.resumeMode,
    expiresAt: claimed.expiresAt,
    task: claimed.task,
  };
}

export function workflowBundleCandidateHeartbeatGenerationError(input: {
  requestedGeneration: number;
  sessionGeneration: number;
  leaseGeneration: number;
  runGeneration: number;
}): "WORKFLOW_BUNDLE_CANDIDATE_HEARTBEAT_GENERATION_MISMATCH" | null {
  return input.requestedGeneration === input.sessionGeneration
    && input.requestedGeneration === input.leaseGeneration
    && input.requestedGeneration === input.runGeneration
    ? null
    : "WORKFLOW_BUNDLE_CANDIDATE_HEARTBEAT_GENERATION_MISMATCH";
}

export async function heartbeatCandidateExecutor(input: AdapterIdentity & {
  sessionId: string;
  generation: number;
}) {
  const { session } = await sessionTask({
    sessionId: input.sessionId,
    runtimeBindingDigest: input.runtimeBindingDigest,
    requireCurrent: false,
  });
  const generationError = workflowBundleCandidateHeartbeatGenerationError({
    requestedGeneration: input.generation,
    sessionGeneration: session.generation,
    leaseGeneration: session.lease.generation,
    runGeneration: session.lease.run.leaseGeneration,
  });
  if (generationError) {
    throw new ControlPlaneError(
      "candidate heartbeat generation binding이 일치하지 않습니다.",
      409,
      generationError,
    );
  }
  const heartbeat = await heartbeatAgentRun({
    sessionId: input.sessionId,
    workerId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    runtimeBindingDigest: input.runtimeBindingDigest,
    leaseSeconds: 300,
    idempotencyKey: input.idempotencyKey,
  });
  return { ...heartbeat, generation: input.generation };
}

export async function authorizeCandidateMutation(input: AdapterIdentity & {
  sessionId: string;
  mutationIntentDigest: string;
  observation: unknown;
}) {
  const { task } = await sessionTask({
    sessionId: input.sessionId,
    runtimeBindingDigest: input.runtimeBindingDigest,
    requireCurrent: true,
  });
  if (task.mutation.intentDigest !== input.mutationIntentDigest.toLowerCase()) {
    throw new ControlPlaneError(
      "candidate mutation intent가 signed task와 다릅니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_INTENT_MISMATCH",
    );
  }
  return authorizeGithubReadyPrMutation({
    sessionId: input.sessionId,
    workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    workerRuntimeBindingDigest: input.runtimeBindingDigest,
    action: "GITHUB_READY_PR_MUTATE",
    mutationIntentDigest: input.mutationIntentDigest,
    observation: agentGithubObservationSchema.parse(input.observation),
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
    idempotencyKey: input.idempotencyKey,
    expectedTarget: {
      headRef: task.github.expectedHeadRef,
      marker: task.github.expectedPullRequestMarker,
    },
  });
}

export async function recoverCandidateMutation(input: AdapterIdentity & { sessionId: string }) {
  await sessionTask({
    sessionId: input.sessionId,
    runtimeBindingDigest: input.runtimeBindingDigest,
    requireCurrent: false,
  });
  return claimGithubMutationRecovery({
    sessionId: input.sessionId,
    workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    workerRuntimeBindingDigest: input.runtimeBindingDigest,
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function claimCandidateMutationStep(input: AdapterIdentity & {
  sessionId: string;
  executionId: string;
  stepKind: "CREATE_COMMIT" | "CREATE_REF" | "CREATE_PR";
}) {
  const current = await sessionTask({
    sessionId: input.sessionId,
    runtimeBindingDigest: input.runtimeBindingDigest,
    requireCurrent: false,
  });
  if (!current.session.lease.run.readbackRequestedAt) {
    await assertWorkflowBundleCandidateTaskCurrent(current.task);
  }
  return claimGithubMutationStep({
    sessionId: input.sessionId,
    executionId: input.executionId,
    workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    workerRuntimeBindingDigest: input.runtimeBindingDigest,
    stepKind: input.stepKind,
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function planCandidateCommitStep(input: AdapterIdentity & {
  sessionId: string;
  executionId: string;
  stepId: string;
  attemptId: string;
  generation: number;
  expectedTreeSha: string;
  expectedCommitSha: string;
}) {
  await sessionTask({
    sessionId: input.sessionId,
    runtimeBindingDigest: input.runtimeBindingDigest,
    requireCurrent: true,
  });
  return planGithubCommitMutationStep({
    sessionId: input.sessionId,
    executionId: input.executionId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    generation: input.generation,
    workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    workerRuntimeBindingDigest: input.runtimeBindingDigest,
    stepKind: "CREATE_COMMIT",
    expectedTreeSha: input.expectedTreeSha,
    expectedCommitSha: input.expectedCommitSha,
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function completeCandidateMutationStep(input: AdapterIdentity & {
  sessionId: string;
  executionId: string;
  stepId: string;
  attemptId: string;
  generation: number;
  stepKind: "CREATE_COMMIT" | "CREATE_REF" | "CREATE_PR";
  observation: unknown;
}) {
  const current = await sessionTask({
    sessionId: input.sessionId,
    runtimeBindingDigest: input.runtimeBindingDigest,
    requireCurrent: false,
  });
  if (!current.session.lease.run.readbackRequestedAt) {
    await assertWorkflowBundleCandidateTaskCurrent(current.task);
  }
  return completeGithubMutationStep({
    sessionId: input.sessionId,
    executionId: input.executionId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    generation: input.generation,
    workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    workerRuntimeBindingDigest: input.runtimeBindingDigest,
    stepKind: input.stepKind,
    observation: agentGithubMutationStepObservationSchema.parse(input.observation),
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function readbackCandidateMutation(input: AdapterIdentity & {
  sessionId: string;
  executionId: string;
  observation: unknown;
}) {
  await sessionTask({
    sessionId: input.sessionId,
    runtimeBindingDigest: input.runtimeBindingDigest,
    requireCurrent: false,
  });
  const result = await recordGithubMutationReadback({
    sessionId: input.sessionId,
    executionId: input.executionId,
    workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    workerRuntimeBindingDigest: input.runtimeBindingDigest,
    observation: agentGithubObservationSchema.parse(input.observation),
    adapterPrincipalId: input.adapterPrincipalId,
    adapterRuntimeIdentity: input.adapterRuntimeIdentity,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    executionId: result.execution.id,
    status: result.readback.status,
    duplicate: result.duplicate,
  };
}

export async function settleCandidateExecutor(input: AdapterIdentity & {
  sessionId: string;
  mode: "START" | "READBACK_FIRST";
  status: "VERIFIED" | "NOT_APPLIED" | "PARTIAL_VERIFIED" | "RESULT_UNKNOWN" | "FAILED";
  executionId: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  commitSha: string | null;
  errorCode: string | null;
}) {
  await sessionTask({
    sessionId: input.sessionId,
    runtimeBindingDigest: input.runtimeBindingDigest,
    requireCurrent: false,
  });
  const verifiedResult = {
    outcomeCode: "PR_READY",
    summary: "WorkflowBundle candidate Ready PR을 exact readback으로 확인했습니다.",
    mutationExecutionId: input.executionId,
    pullRequestNumber: input.pullRequestNumber,
    pullRequestUrl: input.pullRequestUrl,
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    costMicros: 0,
  };
  if (
    input.status === "VERIFIED"
    && (!input.executionId || !input.pullRequestNumber || !input.pullRequestUrl)
  ) {
    throw new ControlPlaneError(
      "VERIFIED settlement에는 exact mutation/PR evidence가 필요합니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_SETTLEMENT_EVIDENCE_MISSING",
    );
  }
  if (input.status === "PARTIAL_VERIFIED" && (input.mode !== "READBACK_FIRST" || !input.executionId)) {
    throw new ControlPlaneError(
      "PARTIAL_VERIFIED settlement에는 READBACK_FIRST exact execution evidence가 필요합니다.",
      409,
      "WORKFLOW_BUNDLE_CANDIDATE_PARTIAL_EVIDENCE_MISSING",
    );
  }
  if (input.mode === "READBACK_FIRST") {
    const resolution = input.status === "VERIFIED"
      ? "COMPLETE"
      : ["NOT_APPLIED", "PARTIAL_VERIFIED"].includes(input.status)
        ? "RESUME"
        : "BLOCKED";
    const result = input.status === "VERIFIED"
      ? verifiedResult
      : input.status === "PARTIAL_VERIFIED"
        ? {
            outcomeCode: "READBACK_PARTIAL_VERIFIED",
            summary: "검증된 mutation prefix 다음 단계가 미적용임을 확인해 동일 run을 재개합니다.",
            mutationExecutionId: input.executionId!,
            costMicros: 0,
          }
      : input.status === "NOT_APPLIED"
        ? {
            outcomeCode: "NO_CHANGES",
            summary: "이전 mutation이 적용되지 않았음을 exact readback으로 확인했습니다.",
            costMicros: 0,
          }
        : {
            outcomeCode: "READBACK_CONFIRMED",
            summary: "이전 mutation 결과를 확정할 수 없어 자동 재시도를 차단했습니다.",
            costMicros: 0,
          };
    return resolveAgentRunReadback({
      sessionId: input.sessionId,
      workerId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
      runtimeBindingDigest: input.runtimeBindingDigest,
      resolution,
      result,
      idempotencyKey: input.idempotencyKey,
    });
  }
  const outcome = input.status === "VERIFIED"
    ? "complete"
    : input.status === "RESULT_UNKNOWN"
      ? "unknown"
      : "fail";
  const result = input.status === "VERIFIED"
    ? verifiedResult
    : input.status === "RESULT_UNKNOWN"
      ? {
          outcomeCode: "RESULT_UNKNOWN",
          summary: "GitHub mutation 결과가 불명확하여 READBACK_FIRST로 전환합니다.",
          mutationExecutionId: input.executionId,
          costMicros: 0,
        }
      : {
          outcomeCode: "NO_CHANGES",
          summary: "GitHub mutation이 적용되지 않았거나 실행 전에 실패했습니다.",
          mutationExecutionId: input.executionId,
          costMicros: 0,
        };
  return settleAgentRun({
    sessionId: input.sessionId,
    workerId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    runtimeBindingDigest: input.runtimeBindingDigest,
    outcome,
    result,
    error: input.errorCode ?? (input.status === "FAILED" ? "WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_FAILED" : undefined),
    idempotencyKey: input.idempotencyKey,
  });
}
