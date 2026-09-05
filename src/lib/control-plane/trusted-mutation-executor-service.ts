import {
  heartbeatAgentRun,
  resolveAgentRunReadback,
  settleAgentRun,
  type ClaimedAgentRun,
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
import type { TrustedExecutorGate } from "@/lib/control-plane/trusted-executor-bindings";
import { prisma } from "@/lib/prisma";

export type TrustedMutationStepKind = "CREATE_COMMIT" | "CREATE_REF" | "CREATE_PR";

/** heartbeat는 claim한 session의 동일 generation에만 결합된다. */
export function trustedExecutorHeartbeatGenerationError(input: {
  requestedGeneration: number;
  sessionGeneration: number;
  leaseGeneration: number;
  runGeneration: number;
  code: string;
}): string | null {
  return input.requestedGeneration === input.sessionGeneration
    && input.requestedGeneration === input.leaseGeneration
    && input.requestedGeneration === input.runGeneration
    ? null
    : input.code;
}

export type TrustedExecutorAdapterIdentity = {
  adapterPrincipalId: string;
  adapterRuntimeIdentity: string;
  runtimeBindingDigest: string;
  idempotencyKey: string;
};

export interface TrustedMutationExecutorBinding<Task> {
  gate: TrustedExecutorGate;
  /** run과 session이 결합되는 실행기 principal이다. */
  principal: string;
  templateKey: string;
  /** runtime binding digest에 들어가는 workload 이름이다. 실행기마다 달라야 한다. */
  workload: string;
  parseTask(raw: unknown): Task;
  assertCurrent(task: Task): Promise<unknown>;
  claimNext(input: {
    runtimeBindingDigest: string;
    idempotencyKey: string;
  }): Promise<(ClaimedAgentRun & { task: Task }) | null>;
  expectedTarget(task: Task): { headRef: string; marker: string };
  /**
   * 서버가 이미 아는 mutation intent digest다. null이면 caller 본문을 중앙이 만들 수 없다는
   * 뜻이고, authorize가 실행기 값을 처음 고정한 뒤 이후 단계가 그 값에 묶인다.
   */
  expectedIntentDigest(task: Task): string | null;
  errorCodes: {
    sessionMismatch: string;
    heartbeatGeneration: string;
    intentMismatch: string;
    settlementEvidence: string;
    partialEvidence: string;
    failed: string;
  };
  verifiedSummary: string;
}

/**
 * 신뢰 실행기 서버 경계다. 실행기마다 task 계약과 principal만 다르고 session 검증,
 * step ledger, settlement 규칙은 같다. 규칙을 실행기 수만큼 복제하지 않으려고 한 구현을
 * 매개변수로 공유한다.
 */
export function createTrustedMutationExecutorService<Task>(
  binding: TrustedMutationExecutorBinding<Task>,
) {
  function runtimeBindingDigest(input: {
    adapterPrincipalId: string;
    adapterRuntimeIdentity: string;
  }): string {
    return jsonDigest({
      schemaVersion: 1,
      principal: binding.principal,
      adapterPrincipalId: input.adapterPrincipalId,
      adapterRuntimeIdentity: input.adapterRuntimeIdentity,
      workload: binding.workload,
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
          include: { run: { include: { occurrence: { include: { definition: true } } } } },
        },
      },
    });
    if (
      !session
      || session.principalId !== binding.principal
      || session.runtimeBindingDigest !== input.runtimeBindingDigest
      || session.lease.workerId !== binding.principal
      || session.lease.run.occurrence.definition.template !== binding.templateKey
      || session.lease.run.occurrence.definition.agentKind !== null
    ) {
      throw new ControlPlaneError(
        "신뢰 실행기 session binding이 일치하지 않습니다.",
        409,
        binding.errorCodes.sessionMismatch,
      );
    }
    const task = binding.parseTask(session.lease.run.taskInput);
    if (input.requireCurrent) await binding.assertCurrent(task);
    return { session, task };
  }

  async function claim(identity: TrustedExecutorAdapterIdentity) {
    const claimed = await binding.claimNext({
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

  async function heartbeat(input: TrustedExecutorAdapterIdentity & {
    sessionId: string;
    generation: number;
  }) {
    const { session } = await sessionTask({
      sessionId: input.sessionId,
      runtimeBindingDigest: input.runtimeBindingDigest,
      requireCurrent: false,
    });
    const generationError = trustedExecutorHeartbeatGenerationError({
      requestedGeneration: input.generation,
      sessionGeneration: session.generation,
      leaseGeneration: session.lease.generation,
      runGeneration: session.lease.run.leaseGeneration,
      code: binding.errorCodes.heartbeatGeneration,
    });
    if (generationError) {
      throw new ControlPlaneError(
        "신뢰 실행기 heartbeat generation binding이 일치하지 않습니다.",
        409,
        generationError,
      );
    }
    const beat = await heartbeatAgentRun({
      sessionId: input.sessionId,
      workerId: binding.principal,
      runtimeBindingDigest: input.runtimeBindingDigest,
      leaseSeconds: 300,
      idempotencyKey: input.idempotencyKey,
    });
    return { ...beat, generation: input.generation };
  }

  async function authorize(input: TrustedExecutorAdapterIdentity & {
    sessionId: string;
    mutationIntentDigest: string;
    observation: unknown;
  }) {
    const { task } = await sessionTask({
      sessionId: input.sessionId,
      runtimeBindingDigest: input.runtimeBindingDigest,
      requireCurrent: true,
    });
    const expected = binding.expectedIntentDigest(task);
    if (expected !== null && expected !== input.mutationIntentDigest.toLowerCase()) {
      throw new ControlPlaneError(
        "mutation intent가 고정된 task와 다릅니다.",
        409,
        binding.errorCodes.intentMismatch,
      );
    }
    return authorizeGithubReadyPrMutation({
      sessionId: input.sessionId,
      workerPrincipalId: binding.principal,
      workerRuntimeBindingDigest: input.runtimeBindingDigest,
      action: "GITHUB_READY_PR_MUTATE",
      mutationIntentDigest: input.mutationIntentDigest,
      observation: agentGithubObservationSchema.parse(input.observation),
      adapterPrincipalId: input.adapterPrincipalId,
      adapterRuntimeIdentity: input.adapterRuntimeIdentity,
      idempotencyKey: input.idempotencyKey,
      expectedTarget: binding.expectedTarget(task),
    });
  }

  async function recover(input: TrustedExecutorAdapterIdentity & { sessionId: string }) {
    await sessionTask({
      sessionId: input.sessionId,
      runtimeBindingDigest: input.runtimeBindingDigest,
      requireCurrent: false,
    });
    return claimGithubMutationRecovery({
      sessionId: input.sessionId,
      workerPrincipalId: binding.principal,
      workerRuntimeBindingDigest: input.runtimeBindingDigest,
      adapterPrincipalId: input.adapterPrincipalId,
      adapterRuntimeIdentity: input.adapterRuntimeIdentity,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async function claimStep(input: TrustedExecutorAdapterIdentity & {
    sessionId: string;
    executionId: string;
    stepKind: TrustedMutationStepKind;
  }) {
    const current = await sessionTask({
      sessionId: input.sessionId,
      runtimeBindingDigest: input.runtimeBindingDigest,
      requireCurrent: false,
    });
    if (!current.session.lease.run.readbackRequestedAt) {
      await binding.assertCurrent(current.task);
    }
    return claimGithubMutationStep({
      sessionId: input.sessionId,
      executionId: input.executionId,
      workerPrincipalId: binding.principal,
      workerRuntimeBindingDigest: input.runtimeBindingDigest,
      stepKind: input.stepKind,
      adapterPrincipalId: input.adapterPrincipalId,
      adapterRuntimeIdentity: input.adapterRuntimeIdentity,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async function planStep(input: TrustedExecutorAdapterIdentity & {
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
      workerPrincipalId: binding.principal,
      workerRuntimeBindingDigest: input.runtimeBindingDigest,
      stepKind: "CREATE_COMMIT",
      expectedTreeSha: input.expectedTreeSha,
      expectedCommitSha: input.expectedCommitSha,
      adapterPrincipalId: input.adapterPrincipalId,
      adapterRuntimeIdentity: input.adapterRuntimeIdentity,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async function completeStep(input: TrustedExecutorAdapterIdentity & {
    sessionId: string;
    executionId: string;
    stepId: string;
    attemptId: string;
    generation: number;
    stepKind: TrustedMutationStepKind;
    observation: unknown;
  }) {
    const current = await sessionTask({
      sessionId: input.sessionId,
      runtimeBindingDigest: input.runtimeBindingDigest,
      requireCurrent: false,
    });
    if (!current.session.lease.run.readbackRequestedAt) {
      await binding.assertCurrent(current.task);
    }
    return completeGithubMutationStep({
      sessionId: input.sessionId,
      executionId: input.executionId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      generation: input.generation,
      workerPrincipalId: binding.principal,
      workerRuntimeBindingDigest: input.runtimeBindingDigest,
      stepKind: input.stepKind,
      observation: agentGithubMutationStepObservationSchema.parse(input.observation),
      adapterPrincipalId: input.adapterPrincipalId,
      adapterRuntimeIdentity: input.adapterRuntimeIdentity,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async function readback(input: TrustedExecutorAdapterIdentity & {
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
      workerPrincipalId: binding.principal,
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

  async function settle(input: TrustedExecutorAdapterIdentity & {
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
      summary: binding.verifiedSummary,
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
        binding.errorCodes.settlementEvidence,
      );
    }
    if (input.status === "PARTIAL_VERIFIED" && (input.mode !== "READBACK_FIRST" || !input.executionId)) {
      throw new ControlPlaneError(
        "PARTIAL_VERIFIED settlement에는 READBACK_FIRST exact execution evidence가 필요합니다.",
        409,
        binding.errorCodes.partialEvidence,
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
        workerId: binding.principal,
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
      workerId: binding.principal,
      runtimeBindingDigest: input.runtimeBindingDigest,
      outcome,
      result,
      error: input.errorCode ?? (input.status === "FAILED" ? binding.errorCodes.failed : undefined),
      idempotencyKey: input.idempotencyKey,
    });
  }

  return {
    runtimeBindingDigest,
    sessionTask,
    claim,
    heartbeat,
    authorize,
    recover,
    claimStep,
    planStep,
    completeStep,
    readback,
    settle,
  };
}
