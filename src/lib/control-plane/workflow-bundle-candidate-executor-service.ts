import {
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
} from "@/lib/control-plane/automation-catalog";
import { createTrustedMutationExecutorService } from "@/lib/control-plane/trusted-mutation-executor-service";
import {
  assertWorkflowBundleCandidateTaskCurrent,
  claimNextWorkflowBundleCandidate,
} from "@/lib/control-plane/workflow-bundle-candidate-service";
import {
  workflowBundleCandidateTaskSchema,
  type WorkflowBundleCandidateTask,
} from "@/lib/control-plane/workflow-bundle-candidate-contract";

const service = createTrustedMutationExecutorService<WorkflowBundleCandidateTask>({
  gate: "workflow-bundle-candidate",
  principal: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
  templateKey: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
  workload: "workflow-bundle-candidate-executor",
  parseTask: (raw) => workflowBundleCandidateTaskSchema.parse(raw),
  assertCurrent: assertWorkflowBundleCandidateTaskCurrent,
  claimNext: claimNextWorkflowBundleCandidate,
  expectedTarget: (task) => ({
    headRef: task.github.expectedHeadRef,
    marker: task.github.expectedPullRequestMarker,
  }),
  // 후보 caller 본문은 task가 이미 담고 있으므로 서버가 intent를 미리 안다.
  expectedIntentDigest: (task) => task.mutation.intentDigest,
  errorCodes: {
    sessionMismatch: "WORKFLOW_BUNDLE_CANDIDATE_SESSION_MISMATCH",
    heartbeatGeneration: "WORKFLOW_BUNDLE_CANDIDATE_HEARTBEAT_GENERATION_MISMATCH",
    intentMismatch: "WORKFLOW_BUNDLE_CANDIDATE_INTENT_MISMATCH",
    settlementEvidence: "WORKFLOW_BUNDLE_CANDIDATE_SETTLEMENT_EVIDENCE_MISSING",
    partialEvidence: "WORKFLOW_BUNDLE_CANDIDATE_PARTIAL_EVIDENCE_MISSING",
    failed: "WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_FAILED",
  },
  verifiedSummary: "WorkflowBundle candidate Ready PR을 exact readback으로 확인했습니다.",
});

export const workflowBundleCandidateRuntimeBindingDigest = service.runtimeBindingDigest;
export const claimCandidateExecutor = service.claim;
export const heartbeatCandidateExecutor = service.heartbeat;
export const authorizeCandidateMutation = service.authorize;
export const recoverCandidateMutation = service.recover;
export const claimCandidateMutationStep = service.claimStep;
export const planCandidateCommitStep = service.planStep;
export const completeCandidateMutationStep = service.completeStep;
export const readbackCandidateMutation = service.readback;
export const settleCandidateExecutor = service.settle;
