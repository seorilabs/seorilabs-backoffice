import {
  APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
  APPROVED_CALLER_RECONCILIATION_EXECUTOR_TEMPLATE_KEY,
} from "@/lib/control-plane/automation-catalog";
import { createTrustedMutationExecutorService } from "@/lib/control-plane/trusted-mutation-executor-service";
import {
  assertApprovedCallerReconciliationTaskCurrent,
  claimNextApprovedCallerReconciliation,
  verifyApprovedCallerBundle,
} from "@/lib/control-plane/approved-caller-reconciliation-service";
import {
  approvedCallerReconciliationTaskSchema,
  type ApprovedCallerReconciliationTask,
} from "@/lib/control-plane/approved-caller-reconciliation-contract";
import type { TrustedExecutorAdapterIdentity } from "@/lib/control-plane/trusted-mutation-executor-service";

const service = createTrustedMutationExecutorService<ApprovedCallerReconciliationTask>({
  gate: "approved-caller-reconciliation",
  principal: APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
  templateKey: APPROVED_CALLER_RECONCILIATION_EXECUTOR_TEMPLATE_KEY,
  workload: "approved-caller-reconciliation-executor",
  parseTask: (raw) => approvedCallerReconciliationTaskSchema.parse(raw),
  assertCurrent: assertApprovedCallerReconciliationTaskCurrent,
  claimNext: claimNextApprovedCallerReconciliation,
  expectedTarget: (task) => ({
    headRef: task.github.expectedHeadRef,
    marker: task.github.expectedPullRequestMarker,
  }),
  // caller 본문은 중앙 계약만 만들 수 있어 서버가 intent digest를 미리 계산하지 못한다.
  // authorize가 실행기 값을 처음 고정하고, 이후 모든 step이 그 값에 묶인다.
  expectedIntentDigest: () => null,
  errorCodes: {
    sessionMismatch: "APPROVED_CALLER_SESSION_MISMATCH",
    heartbeatGeneration: "APPROVED_CALLER_HEARTBEAT_GENERATION_MISMATCH",
    intentMismatch: "APPROVED_CALLER_INTENT_MISMATCH",
    settlementEvidence: "APPROVED_CALLER_SETTLEMENT_EVIDENCE_MISSING",
    partialEvidence: "APPROVED_CALLER_PARTIAL_EVIDENCE_MISSING",
    failed: "APPROVED_CALLER_RECONCILIATION_EXECUTOR_FAILED",
  },
  verifiedSummary: "승인 번들 caller Ready PR을 exact readback으로 확인했습니다.",
});

export const approvedCallerReconciliationRuntimeBindingDigest = service.runtimeBindingDigest;
export const claimApprovedCallerExecutor = service.claim;
export const heartbeatApprovedCallerExecutor = service.heartbeat;
export const authorizeApprovedCallerMutation = service.authorize;
export const recoverApprovedCallerMutation = service.recover;
export const claimApprovedCallerMutationStep = service.claimStep;
export const planApprovedCallerCommitStep = service.planStep;
export const completeApprovedCallerMutationStep = service.completeStep;
export const readbackApprovedCallerMutation = service.readback;
export const settleApprovedCallerExecutor = service.settle;

/**
 * 실행기는 승인 서명 trust root를 갖지 않는다. 계약이 요구하는 검증 envelope을 중앙이
 * 만들어 주되, 실행기가 계약에서 계산한 digest와 전부 일치할 때만 VERIFIED를 돌려준다.
 */
export async function verifyApprovedCallerBundleForSession(
  input: TrustedExecutorAdapterIdentity & {
    sessionId: string;
    candidateDigest: string;
    payloadDigest: string;
    approvalPayloadDigest: string;
    contractDigestsDigest: string;
    runtimeAssetDigestsDigest: string;
    evidenceDigest: string;
  },
) {
  const { task } = await service.sessionTask({
    sessionId: input.sessionId,
    runtimeBindingDigest: input.runtimeBindingDigest,
    requireCurrent: true,
  });
  return verifyApprovedCallerBundle({ ...input, task });
}
