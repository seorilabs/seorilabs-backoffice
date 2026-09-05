import { z } from "zod";

import { containsCredentialCandidate } from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { resolvedWorkflowBindingEnvelopeSchema } from "@/lib/control-plane/resolved-workflow-binding";

export const APPROVED_CALLER_RECONCILIATION_EXECUTOR_CONTRACT =
  "approved-caller-reconciliation-executor/v1" as const;

/** 승인 번들이 반증하는 caller는 이 경로 하나다. */
export const APPROVED_CALLER_PATH = ".github/workflows/org-contract.yml" as const;

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/u;
const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/u;

const publicText = (maxLength: number) => z.string().min(1).max(maxLength).refine(
  (value) => !containsCredentialCandidate(value),
  "credential 후보가 없는 공개 문자열이 필요합니다.",
);

export const approvedCallerReconciliationExecutionRequestSchema = z.object({
  mode: z.enum(["PLAN", "ENQUEUE"]),
  repositoryId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
}).strict();

export type ApprovedCallerReconciliationExecutionRequest = z.infer<
  typeof approvedCallerReconciliationExecutionRequestSchema
>;

/**
 * caller 본문은 이 task에 담기지 않는다. 중앙 계약(`generateStaticCallerV5`)만 caller를
 * 만들 수 있고 그 구현은 Next 번들에 들어가지 못하므로, Backoffice는 계약이 요구하는 입력
 * (승인 번들, resolved binding, 대상 저장소)만 고정하고 본문 생성은 실행기가 한다.
 */
export const approvedCallerReconciliationTaskSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal(APPROVED_CALLER_RECONCILIATION_EXECUTOR_CONTRACT),
  approvedBundle: z.object({
    registryRecordId: z.string().regex(PUBLIC_ID),
    sourceSha: z.string().regex(SHA40),
    payloadDigest: z.string().regex(SHA256),
    approvalKeyId: z.string().regex(PUBLIC_ID),
    // 승인 번들 본문이다. 형태 검증은 중앙 registry와 계약이 각각 다시 한다.
    bundle: z.record(z.string(), z.unknown()),
  }).strict(),
  repository: z.object({
    id: z.string().regex(/^[1-9][0-9]{0,31}$/u),
    fullName: z.string().regex(REPOSITORY),
    sourceSha: z.string().regex(SHA40),
    sourceRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,240}$/u),
    defaultBranch: z.string().regex(/^[A-Za-z0-9._/-]{1,240}$/u),
    // caller 반증은 Issue를 닫지 않는다. adapter가 Closes 지시를 붙이지 못하게 고정한다.
    issueNumber: z.null(),
  }).strict(),
  caller: z.object({ path: z.literal(APPROVED_CALLER_PATH) }).strict(),
  resolvedManifest: resolvedWorkflowBindingEnvelopeSchema,
  github: z.object({
    installationId: z.string().regex(/^[1-9][0-9]{0,29}$/u),
    expectedHeadRef: z.string().regex(
      /^refs\/heads\/seori\/approved-caller\/[1-9][0-9]{0,31}\/[0-9a-f]{12}\/[0-9a-f]{64}$/u,
    ),
    expectedPullRequestMarker: z.string().regex(PUBLIC_ID),
  }).strict(),
  mutation: z.object({
    title: publicText(180),
    body: publicText(20_000),
    commitMessage: publicText(240),
  }).strict(),
  planDigest: z.string().regex(DIGEST),
}).strict().superRefine((task, context) => {
  const manifest = task.resolvedManifest;
  if (
    manifest.repositoryId !== task.repository.id
    || manifest.fullName !== task.repository.fullName
    || manifest.sourceSha !== task.repository.sourceSha
    || manifest.manifest.sourceRef !== task.repository.sourceRef
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["resolvedManifest"],
      message: "resolved binding이 대상 저장소 exact source와 다릅니다.",
    });
  }
  const planIdentity = callerPlanIdentity(task);
  if (task.github.expectedHeadRef !== callerHeadRef(
    task.repository.id,
    task.approvedBundle.sourceSha,
    planIdentity,
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["github", "expectedHeadRef"],
      message: "caller branch가 계획 identity와 일치하지 않습니다.",
    });
  }
  if (task.github.expectedPullRequestMarker !== callerMarker(task.repository.id, planIdentity)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["github", "expectedPullRequestMarker"],
      message: "caller PR marker가 계획 identity와 일치하지 않습니다.",
    });
  }
  if (task.planDigest !== callerTaskPlanDigest(task)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["planDigest"],
      message: "caller 계획 digest가 일치하지 않습니다.",
    });
  }
});

export type ApprovedCallerReconciliationTask = z.infer<
  typeof approvedCallerReconciliationTaskSchema
>;

type PlanIdentityInput = Pick<
  ApprovedCallerReconciliationTask,
  "approvedBundle" | "repository" | "resolvedManifest" | "github" | "mutation"
>;

export function callerHeadRef(
  repositoryId: string,
  approvedBundleSha: string,
  planIdentity: string,
): string {
  return `refs/heads/seori/approved-caller/${repositoryId}/${approvedBundleSha.slice(0, 12)}/${planIdentity}`;
}

function callerMarker(repositoryId: string, planIdentity: string): string {
  return `seori-run:approved-caller:${repositoryId}:${planIdentity}`;
}

/**
 * 번들 본문 전체가 아니라 서명이 고정한 digest만 identity에 넣는다. 같은 승인 번들과 같은
 * resolved binding이면 같은 branch/marker가 나오고, 하나라도 바뀌면 새 계획이 된다.
 */
function callerPlanIdentity(task: PlanIdentityInput): string {
  return jsonDigest({
    schemaVersion: 1,
    approvedBundle: {
      registryRecordId: task.approvedBundle.registryRecordId,
      sourceSha: task.approvedBundle.sourceSha,
      payloadDigest: task.approvedBundle.payloadDigest,
      approvalKeyId: task.approvedBundle.approvalKeyId,
    },
    repository: task.repository,
    resolvedManifestDigest: task.resolvedManifest.manifestDigest,
    githubInstallationId: task.github.installationId,
    mutation: task.mutation,
  } as unknown as JsonValue);
}

function callerTaskPlanDigest(
  task: Omit<ApprovedCallerReconciliationTask, "planDigest"> | ApprovedCallerReconciliationTask,
): string {
  const payload = { ...task } as Partial<ApprovedCallerReconciliationTask>;
  delete payload.planDigest;
  return jsonDigest(payload as unknown as JsonValue);
}

export function approvedCallerMutationTexts(input: {
  approvedBundleSourceSha: string;
  registryRecordId: string;
  configRevision: number;
  callerPath: string;
}) {
  return {
    title: "승인된 중앙 워크플로 caller를 맞춘다",
    body: [
      `승인된 WorkflowBundle \`${input.approvedBundleSourceSha}\`(registry \`${input.registryRecordId}\`)이 지정한 중앙 워크플로를 이 저장소의 \`${input.callerPath}\`에 반영합니다.`,
      `ACTIVE 설정 revision ${input.configRevision}이 결합한 resolved binding에서 중앙 계약이 caller 본문을 만들었고, 이 PR은 그 파일 하나만 바꿉니다.`,
      "마켓 업로드, 심사 제출, 공개 배포는 이 변경에 포함되지 않습니다.",
    ].join("\n\n"),
    commitMessage: "ci: 승인된 중앙 워크플로 caller를 갱신한다",
  };
}

export function buildApprovedCallerReconciliationTask(input: {
  approvedBundle: {
    registryRecordId: string;
    sourceSha: string;
    payloadDigest: string;
    approvalKeyId: string;
    bundle: Record<string, unknown>;
  };
  repositoryId: string;
  fullName: string;
  sourceSha: string;
  sourceRef: string;
  defaultBranch: string;
  callerPath: string;
  resolvedManifest: unknown;
  installationId: string;
}): ApprovedCallerReconciliationTask {
  const resolvedManifest = resolvedWorkflowBindingEnvelopeSchema.parse(input.resolvedManifest);
  const partial = {
    schemaVersion: 1 as const,
    contract: APPROVED_CALLER_RECONCILIATION_EXECUTOR_CONTRACT,
    approvedBundle: input.approvedBundle,
    repository: {
      id: input.repositoryId,
      fullName: input.fullName,
      sourceSha: input.sourceSha,
      sourceRef: input.sourceRef,
      defaultBranch: input.defaultBranch,
      issueNumber: null,
    },
    caller: { path: input.callerPath as typeof APPROVED_CALLER_PATH },
    resolvedManifest,
    github: {
      installationId: input.installationId,
      expectedHeadRef: "refs/heads/placeholder",
      expectedPullRequestMarker: "placeholder",
    },
    mutation: approvedCallerMutationTexts({
      approvedBundleSourceSha: input.approvedBundle.sourceSha,
      registryRecordId: input.approvedBundle.registryRecordId,
      configRevision: resolvedManifest.configRevision,
      callerPath: input.callerPath,
    }),
  };
  const planIdentity = callerPlanIdentity(partial as PlanIdentityInput);
  partial.github.expectedHeadRef = callerHeadRef(
    input.repositoryId,
    input.approvedBundle.sourceSha,
    planIdentity,
  );
  partial.github.expectedPullRequestMarker = callerMarker(input.repositoryId, planIdentity);
  return approvedCallerReconciliationTaskSchema.parse({
    ...partial,
    planDigest: callerTaskPlanDigest(
      partial as Omit<ApprovedCallerReconciliationTask, "planDigest">,
    ),
  });
}

/** 공개 응답에는 실행기가 계약을 부르는 데 필요한 좌표만 남기고 번들 본문은 뺀다. */
export function publicApprovedCallerReconciliationTask(task: ApprovedCallerReconciliationTask) {
  return {
    contract: task.contract,
    planDigest: task.planDigest,
    approvedBundle: {
      registryRecordId: task.approvedBundle.registryRecordId,
      sourceSha: task.approvedBundle.sourceSha,
      payloadDigest: task.approvedBundle.payloadDigest,
      approvalKeyId: task.approvedBundle.approvalKeyId,
    },
    repository: task.repository,
    caller: task.caller,
    resolvedManifestDigest: task.resolvedManifest.manifestDigest,
    github: task.github,
    mutation: { title: task.mutation.title },
  };
}

/** READY_PR adapter가 받는 command다. 파일은 실행기가 계약에서 만들어 채운다. */
export function approvedCallerReconciliationCommand(
  task: ApprovedCallerReconciliationTask,
  sessionId: string,
) {
  return {
    sessionId,
    repoId: task.repository.id,
    repoFullName: task.repository.fullName,
    issueNumber: null,
    sourceSha: task.repository.sourceSha,
    title: task.mutation.title,
    body: task.mutation.body,
    commitMessage: task.mutation.commitMessage,
  };
}
