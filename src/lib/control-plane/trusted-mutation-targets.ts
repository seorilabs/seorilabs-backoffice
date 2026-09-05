import {
  APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
  APPROVED_CALLER_RECONCILIATION_EXECUTOR_TEMPLATE_KEY,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
} from "@/lib/control-plane/automation-catalog";
import { approvedCallerReconciliationTaskSchema } from "@/lib/control-plane/approved-caller-reconciliation-contract";
import { workflowBundleCandidateTaskSchema } from "@/lib/control-plane/workflow-bundle-candidate-contract";

export interface TrustedMutationTargetRequest {
  taskInput: unknown;
  session: {
    repoId: bigint;
    repoFullName: string;
    issueNumber: number | null;
    sourceSha: string;
  };
  mutationIntentDigest: string;
  requested: { headRef: string; marker: string };
}

/**
 * 신뢰 실행기만 자기 task가 고정한 branch/marker를 mutation target으로 요청할 수 있다.
 * 일반 READY_PR definition은 서버가 생성한 target만 쓴다. 실행기를 추가할 때 이 표에
 * 넣지 않으면 custom target이 fail-closed로 거부된다.
 */
export interface TrustedMutationTargetBinding {
  templateKey: string;
  principal: string;
  /** task가 session·요청 target과 exact로 맞는지 본다. */
  matches(input: TrustedMutationTargetRequest): boolean;
}

function repositoryMatches(
  repository: { id: string; fullName: string; issueNumber: number | null; sourceSha: string },
  session: TrustedMutationTargetRequest["session"],
): boolean {
  return repository.id === session.repoId.toString()
    && repository.fullName.toLowerCase() === session.repoFullName.toLowerCase()
    && repository.issueNumber === session.issueNumber
    && repository.sourceSha === session.sourceSha.toLowerCase();
}

const CANDIDATE: TrustedMutationTargetBinding = {
  templateKey: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
  principal: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
  matches: (input) => {
    const task = workflowBundleCandidateTaskSchema.safeParse(input.taskInput);
    return task.success
      && repositoryMatches(task.data.repository, input.session)
      // 후보 caller 본문은 task 안에 있어 intent digest를 여기서 대조할 수 있다.
      && task.data.mutation.intentDigest === input.mutationIntentDigest.toLowerCase()
      && task.data.github.expectedHeadRef === input.requested.headRef
      && task.data.github.expectedPullRequestMarker === input.requested.marker;
  },
};

const APPROVED_CALLER: TrustedMutationTargetBinding = {
  templateKey: APPROVED_CALLER_RECONCILIATION_EXECUTOR_TEMPLATE_KEY,
  principal: APPROVED_CALLER_RECONCILIATION_EXECUTOR_PRINCIPAL,
  matches: (input) => {
    const task = approvedCallerReconciliationTaskSchema.safeParse(input.taskInput);
    // caller 본문은 중앙 계약만 만들 수 있어 intent digest를 미리 알지 못한다. authorize가
    // 실행기 값을 처음 고정하고, 이후 step ledger가 그 execution의 digest에 묶인다.
    return task.success
      && repositoryMatches(task.data.repository, input.session)
      && task.data.github.expectedHeadRef === input.requested.headRef
      && task.data.github.expectedPullRequestMarker === input.requested.marker;
  },
};

export const TRUSTED_MUTATION_TARGET_BINDINGS: readonly TrustedMutationTargetBinding[] =
  Object.freeze([CANDIDATE, APPROVED_CALLER]);

export function trustedMutationTargetBinding(
  templateKey: string,
): TrustedMutationTargetBinding | undefined {
  return TRUSTED_MUTATION_TARGET_BINDINGS.find((binding) => binding.templateKey === templateKey);
}
