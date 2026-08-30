import { stringify } from "yaml";
import { z } from "zod";

import { containsCredentialCandidate } from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { workflowBundleV5RegistrySchema } from "@/lib/control-plane/workflow-bundle-v5-registry";

export const WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_CONTRACT =
  "workflow-bundle-candidate-executor/v1" as const;

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/u;
const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const STATIC_CALLER_PATH = ".github/workflows/org-contract.yml" as const;
const ANDROID_CALLER_PATH = ".github/workflows/android-build-only.yml" as const;
const requiredUnknown = z.unknown().refine((value) => value !== undefined);

export const WORKFLOW_BUNDLE_CANDIDATE_CALLER_PATHS = Object.freeze([
  STATIC_CALLER_PATH,
  ANDROID_CALLER_PATH,
] as const);

const CANDIDATE_REPOSITORIES = Object.freeze({
  "1250442131": Object.freeze({
    fullName: "seorilabs/happy-farm",
    staticProfile: "react-native",
    buildProfile: "react-native-android",
  }),
  "1265192029": Object.freeze({
    fullName: "seorilabs/lizard-tycoon",
    staticProfile: "godot",
    buildProfile: "godot-android",
  }),
} as const);

export const workflowBundleCandidateExecutionRequestSchema = z.object({
  mode: z.enum(["PLAN", "ENQUEUE"]),
  workflowBundleRecordId: z.string().regex(PUBLIC_ID),
  repositoryId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
  sourceSha: z.string().regex(SHA40),
  issueNumber: z.number().int().positive().nullable().default(null),
}).strict();

export type WorkflowBundleCandidateExecutionRequest = z.infer<
  typeof workflowBundleCandidateExecutionRequestSchema
>;

const publicText = (maxLength: number) => z.string().min(1).max(maxLength).refine(
  (value) => !containsCredentialCandidate(value),
  "credential 후보가 없는 공개 문자열이 필요합니다.",
);

const candidateFileSchema = z.object({
  path: z.enum(WORKFLOW_BUNDLE_CANDIDATE_CALLER_PATHS),
  mode: z.literal("100644"),
  contentBase64: z.string().min(1).max(2 * 1024 * 1024),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

export const workflowBundleCandidateTaskSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal(WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_CONTRACT),
  candidate: z.object({
    recordId: z.string().regex(PUBLIC_ID),
    sourceSha: z.string().regex(SHA40),
    payloadDigest: z.string().regex(SHA256),
    artifactRunId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
    artifactId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
    artifactDigest: z.string().regex(SHA256),
  }).strict(),
  config: z.object({
    revisionId: z.string().regex(PUBLIC_ID),
    revision: z.number().int().positive(),
    snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict(),
  repository: z.object({
    id: z.string().regex(/^[1-9][0-9]{0,31}$/u),
    fullName: z.string().regex(REPOSITORY),
    sourceSha: z.string().regex(SHA40),
    defaultBranch: z.string().regex(/^[A-Za-z0-9._/-]{1,240}$/u),
    issueNumber: z.number().int().positive().nullable(),
  }).strict(),
  github: z.object({
    installationId: z.string().regex(/^[1-9][0-9]{0,29}$/u),
    expectedHeadRef: z.string().regex(/^refs\/heads\/seori\/workflow-bundle-v5-canary\/[1-9][0-9]{0,31}\/[0-9a-f]{12}\/[0-9a-f]{64}$/u),
    expectedPullRequestMarker: z.string().regex(PUBLIC_ID),
  }).strict(),
  mutation: z.object({
    title: publicText(180),
    body: publicText(20_000),
    commitMessage: publicText(240),
    files: z.array(candidateFileSchema).length(2),
    intentDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict(),
  planDigest: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict().superRefine((task, context) => {
  const repository = CANDIDATE_REPOSITORIES[
    task.repository.id as keyof typeof CANDIDATE_REPOSITORIES
  ];
  if (!repository || repository.fullName !== task.repository.fullName) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repository"],
      message: "고정 canary repository가 아닙니다.",
    });
  }
  const planIdentity = candidatePlanIdentity(task);
  const expectedHeadRef = candidateHeadRef(
    task.repository.id,
    task.candidate.sourceSha,
    planIdentity,
  );
  if (task.github.expectedHeadRef !== expectedHeadRef) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["github", "expectedHeadRef"],
      message: "candidate branch가 record source와 일치하지 않습니다.",
    });
  }
  if (task.github.expectedPullRequestMarker !== candidateMarker(task.repository.id, planIdentity)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["github", "expectedPullRequestMarker"],
      message: "candidate PR marker가 plan identity와 일치하지 않습니다.",
    });
  }
  const paths = task.mutation.files.map((file) => file.path);
  if (
    new Set(paths).size !== 2
    || WORKFLOW_BUNDLE_CANDIDATE_CALLER_PATHS.some((path) => !paths.includes(path))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mutation", "files"],
      message: "candidate caller 두 파일만 허용됩니다.",
    });
  }
  for (const [index, file] of task.mutation.files.entries()) {
    let content = "";
    try {
      const bytes = Buffer.from(file.contentBase64, "base64");
      if (bytes.toString("base64") === file.contentBase64) content = bytes.toString("utf8");
      bytes.fill(0);
    } catch {
      // invalid content is reported by the single issue below
    }
    if (!content || jsonDigest(content) !== file.contentSha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mutation", "files", index],
        message: "caller content digest가 일치하지 않습니다.",
      });
    }
  }
  const expectedIntent = candidateMutationIntentDigest(task);
  if (task.mutation.intentDigest !== expectedIntent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mutation", "intentDigest"],
      message: "mutation intent digest가 일치하지 않습니다.",
    });
  }
  const expectedPlan = candidateTaskPlanDigest(task);
  if (task.planDigest !== expectedPlan) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["planDigest"],
      message: "candidate plan digest가 일치하지 않습니다.",
    });
  }
});

export type WorkflowBundleCandidateTask = z.infer<typeof workflowBundleCandidateTaskSchema>;

export const workflowBundleCandidateExecutorRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("CLAIM") }).strict(),
  z.object({
    operation: z.literal("HEARTBEAT"),
    sessionId: z.string().regex(/^agent-session:[0-9a-f-]{36}$/u),
    generation: z.number().int().positive(),
  }).strict(),
  z.object({
    operation: z.literal("AUTHORIZE"),
    sessionId: z.string().regex(/^agent-session:[0-9a-f-]{36}$/u),
    mutationIntentDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    observation: requiredUnknown,
  }).strict(),
  z.object({
    operation: z.literal("STEP_CLAIM"),
    sessionId: z.string().regex(/^agent-session:[0-9a-f-]{36}$/u),
    executionId: z.string().regex(PUBLIC_ID),
    stepKind: z.enum(["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"]),
  }).strict(),
  z.object({
    operation: z.literal("STEP_PLAN"),
    sessionId: z.string().regex(/^agent-session:[0-9a-f-]{36}$/u),
    executionId: z.string().regex(PUBLIC_ID),
    stepId: z.string().regex(PUBLIC_ID),
    attemptId: z.string().regex(PUBLIC_ID),
    generation: z.number().int().positive(),
    expectedTreeSha: z.string().regex(SHA40),
    expectedCommitSha: z.string().regex(SHA40),
  }).strict(),
  z.object({
    operation: z.literal("STEP_COMPLETE"),
    sessionId: z.string().regex(/^agent-session:[0-9a-f-]{36}$/u),
    executionId: z.string().regex(PUBLIC_ID),
    stepId: z.string().regex(PUBLIC_ID),
    attemptId: z.string().regex(PUBLIC_ID),
    generation: z.number().int().positive(),
    stepKind: z.enum(["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"]),
    observation: requiredUnknown,
  }).strict(),
  z.object({
    operation: z.literal("READBACK"),
    sessionId: z.string().regex(/^agent-session:[0-9a-f-]{36}$/u),
    executionId: z.string().regex(PUBLIC_ID),
    observation: requiredUnknown,
  }).strict(),
  z.object({
    operation: z.literal("RECOVERY"),
    sessionId: z.string().regex(/^agent-session:[0-9a-f-]{36}$/u),
  }).strict(),
  z.object({
    operation: z.literal("SETTLE"),
    sessionId: z.string().regex(/^agent-session:[0-9a-f-]{36}$/u),
    mode: z.enum(["START", "READBACK_FIRST"]),
    status: z.enum(["VERIFIED", "NOT_APPLIED", "PARTIAL_VERIFIED", "RESULT_UNKNOWN", "FAILED"]),
    executionId: z.string().regex(PUBLIC_ID).nullable(),
    pullRequestNumber: z.number().int().positive().nullable(),
    pullRequestUrl: z.string().url().startsWith("https://github.com/").nullable(),
    commitSha: z.string().regex(SHA40).nullable(),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{7,190}$/u).nullable(),
  }).strict(),
]);

export type WorkflowBundleCandidateExecutorRequest = z.infer<
  typeof workflowBundleCandidateExecutorRequestSchema
>;

type ResolvedCandidateManifest = {
  app: { status: string; repoFullName: string; repoId: string | null };
  source: { sha: string; ref: string | null };
  workflowCaller: { profile: string };
  config: {
    id: string;
    revision: number;
    status: string;
    digest: string | null;
    signature: string | null;
  };
  workflowBundleBinding?: { sourceSha: string; payloadDigest: string };
};

type CandidateRegistryRecord = {
  id: string;
  approvalState: "CANDIDATE" | "APPROVED";
  sourceSha: string;
  payloadDigest: string;
  artifactRunId: bigint | null;
  artifactId: bigint | null;
  artifactDigest: string | null;
  bundle: unknown;
};

function workflowDocument(value: Record<string, unknown>): string {
  return [
    "# WorkflowBundle v5 generator가 관리합니다. 수동 편집하지 마십시오.",
    stringify(value, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
}

function staticPermissions(profile: "react-native" | "godot") {
  return profile === "godot"
    ? { contents: "read", "id-token": "write" }
    : { contents: "read", "id-token": "write", packages: "read" };
}

function buildPermissions(profile: "react-native-android" | "godot-android") {
  return profile === "react-native-android"
    ? { contents: "read", "id-token": "write", packages: "read" }
    : { contents: "read", "id-token": "write" };
}

export function candidateHeadRef(
  repositoryId: string,
  candidateSourceSha: string,
  planIdentity: string,
): string {
  return `refs/heads/seori/workflow-bundle-v5-canary/${repositoryId}/${candidateSourceSha.slice(0, 12)}/${planIdentity}`;
}

function candidateMarker(repositoryId: string, planIdentity: string): string {
  return `seori-run:workflow-bundle-v5-canary:${repositoryId}:${planIdentity}`;
}

function candidatePlanIdentity(
  task: Pick<WorkflowBundleCandidateTask, "candidate" | "config" | "repository" | "github" | "mutation">,
): string {
  return jsonDigest({
    schemaVersion: 1,
    candidate: task.candidate,
    config: task.config,
    repository: task.repository,
    githubInstallationId: task.github.installationId,
    mutationIntentDigest: task.mutation.intentDigest,
  } as unknown as JsonValue);
}

function candidateTaskPlanDigest(task: Omit<WorkflowBundleCandidateTask, "planDigest"> | WorkflowBundleCandidateTask): string {
  const payload = { ...task } as Partial<WorkflowBundleCandidateTask>;
  delete payload.planDigest;
  return jsonDigest(payload as unknown as JsonValue);
}

function candidateMutationIntentDigest(task: Pick<WorkflowBundleCandidateTask, "repository" | "mutation">): string {
  return jsonDigest({
    schemaVersion: 1,
    repoId: task.repository.id,
    repoFullName: task.repository.fullName.toLowerCase(),
    issueNumber: task.repository.issueNumber,
    sourceSha: task.repository.sourceSha.toLowerCase(),
    title: task.mutation.title,
    body: task.mutation.body,
    commitMessage: task.mutation.commitMessage,
    files: [...task.mutation.files]
      .map((file) => ({
        path: file.path,
        mode: file.mode,
        contentSha256: file.contentSha256,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
}

export function buildWorkflowBundleCandidateTask(input: {
  record: CandidateRegistryRecord;
  resolved: ResolvedCandidateManifest;
  repositoryId: string;
  fullName: string;
  sourceSha: string;
  defaultBranch: string;
  issueNumber: number | null;
  installationId: string;
}): WorkflowBundleCandidateTask {
  const allowed = CANDIDATE_REPOSITORIES[
    input.repositoryId as keyof typeof CANDIDATE_REPOSITORIES
  ];
  if (!allowed || allowed.fullName !== input.fullName) {
    throw new Error("WORKFLOW_BUNDLE_CANDIDATE_REPOSITORY_NOT_ALLOWED");
  }
  const bundle = workflowBundleV5RegistrySchema.parse(input.record.bundle);
  if (
    input.record.approvalState !== "CANDIDATE"
    || bundle.approval.state !== "CANDIDATE"
    || input.record.sourceSha !== bundle.source.sha
    || input.record.payloadDigest !== bundle.integrity.payloadDigest
    || !input.record.artifactRunId
    || !input.record.artifactId
    || !input.record.artifactDigest
  ) throw new Error("WORKFLOW_BUNDLE_CANDIDATE_RECORD_INVALID");
  if (
    input.resolved.app.status !== "ACTIVE"
    || input.resolved.app.repoFullName !== input.fullName
    || input.resolved.app.repoId !== input.repositoryId
    || input.resolved.source.sha !== input.sourceSha
    || input.resolved.source.ref !== `refs/heads/${input.defaultBranch}`
    || input.resolved.workflowCaller.profile !== allowed.staticProfile
    || input.resolved.config.status !== "ACTIVE"
    || !input.resolved.config.digest
    || !input.resolved.config.signature
    || input.resolved.workflowBundleBinding?.sourceSha !== bundle.source.sha
    || input.resolved.workflowBundleBinding?.payloadDigest !== bundle.integrity.payloadDigest
  ) throw new Error("WORKFLOW_BUNDLE_CANDIDATE_ACTIVE_CONFIG_MISMATCH");
  const staticWorkflow = bundle.staticProfiles[allowed.staticProfile];
  const buildWorkflow = bundle.buildProfiles[allowed.buildProfile];
  if (
    staticWorkflow.sha !== bundle.source.sha
    || buildWorkflow.sha !== bundle.source.sha
    || buildWorkflow.workflow === null
    || !bundle.promotionScope.buildProfiles.includes(allowed.buildProfile)
  ) throw new Error("WORKFLOW_BUNDLE_CANDIDATE_PROFILE_MISMATCH");

  const staticCaller = workflowDocument({
    name: "Org Contract",
    on: { pull_request: { paths: [STATIC_CALLER_PATH] } },
    permissions: staticPermissions(allowed.staticProfile),
    concurrency: {
      group: "org-contract-${{ github.repository_id }}-${{ github.ref }}",
      "cancel-in-progress": true,
    },
    jobs: {
      "org-contract": {
        uses: `seorilabs/.github/${staticWorkflow.path}@${staticWorkflow.sha}`,
      },
    },
  });
  const androidCaller = workflowDocument({
    name: "Android Build-only",
    on: { pull_request: { paths: [ANDROID_CALLER_PATH] } },
    permissions: buildPermissions(allowed.buildProfile),
    concurrency: {
      group: "android-build-${{ github.repository_id }}-${{ github.ref }}",
      "cancel-in-progress": false,
    },
    jobs: {
      "android-build": {
        uses: `seorilabs/.github/${buildWorkflow.workflow}@${buildWorkflow.sha}`,
      },
    },
  });
  const files = [
    { path: STATIC_CALLER_PATH, content: staticCaller },
    { path: ANDROID_CALLER_PATH, content: androidCaller },
  ].map(({ path, content }) => ({
    path,
    mode: "100644" as const,
    contentBase64: Buffer.from(content, "utf8").toString("base64"),
    contentSha256: jsonDigest(content),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const title = "WorkflowBundle v5 후보를 검증한다";
  const body = [
    `중앙 WorkflowBundle 후보 \`${bundle.source.sha}\`의 thin caller를 exact source에서 검증합니다.`,
    "static check와 Android build-only만 실행하며 마켓 업로드·심사·공개 배포는 수행하지 않습니다.",
  ].join("\n\n");
  const commitMessage = "ci: WorkflowBundle v5 후보 caller를 갱신한다";
  const partial = {
    schemaVersion: 1 as const,
    contract: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_CONTRACT,
    candidate: {
      recordId: input.record.id,
      sourceSha: bundle.source.sha,
      payloadDigest: bundle.integrity.payloadDigest,
      artifactRunId: input.record.artifactRunId.toString(),
      artifactId: input.record.artifactId.toString(),
      artifactDigest: input.record.artifactDigest,
    },
    config: {
      revisionId: input.resolved.config.id,
      revision: input.resolved.config.revision,
      snapshotDigest: input.resolved.config.digest,
    },
    repository: {
      id: input.repositoryId,
      fullName: input.fullName,
      sourceSha: input.sourceSha,
      defaultBranch: input.defaultBranch,
      issueNumber: input.issueNumber,
    },
    github: {
      installationId: input.installationId,
      expectedHeadRef: "refs/heads/placeholder",
      expectedPullRequestMarker: "placeholder",
    },
    mutation: {
      title,
      body,
      commitMessage,
      files,
      intentDigest: "0".repeat(64),
    },
  };
  partial.mutation.intentDigest = candidateMutationIntentDigest(partial);
  const planIdentity = candidatePlanIdentity(partial as unknown as Pick<
    WorkflowBundleCandidateTask,
    "candidate" | "config" | "repository" | "github" | "mutation"
  >);
  partial.github.expectedHeadRef = candidateHeadRef(input.repositoryId, bundle.source.sha, planIdentity);
  partial.github.expectedPullRequestMarker = candidateMarker(input.repositoryId, planIdentity);
  const task = {
    ...partial,
    planDigest: candidateTaskPlanDigest(partial as Omit<WorkflowBundleCandidateTask, "planDigest">),
  };
  return workflowBundleCandidateTaskSchema.parse(task);
}

export function publicWorkflowBundleCandidateTask(task: WorkflowBundleCandidateTask) {
  return {
    contract: task.contract,
    planDigest: task.planDigest,
    candidate: task.candidate,
    config: task.config,
    repository: task.repository,
    github: task.github,
    mutation: {
      title: task.mutation.title,
      files: task.mutation.files.map((file) => ({
        path: file.path,
        mode: file.mode,
        contentSha256: file.contentSha256,
      })),
      intentDigest: task.mutation.intentDigest,
    },
  };
}

export function workflowBundleCandidateCommand(task: WorkflowBundleCandidateTask, sessionId: string) {
  return {
    sessionId,
    repoId: task.repository.id,
    repoFullName: task.repository.fullName,
    issueNumber: task.repository.issueNumber,
    sourceSha: task.repository.sourceSha,
    title: task.mutation.title,
    body: task.mutation.body,
    commitMessage: task.mutation.commitMessage,
    files: task.mutation.files,
  };
}

export function prepareWorkflowBundleCandidateFiles(task: WorkflowBundleCandidateTask) {
  const parsed = workflowBundleCandidateTaskSchema.parse(task);
  return parsed.mutation.files.map((file) => {
    const bytes = Buffer.from(file.contentBase64, "base64");
    try {
      if (bytes.toString("base64") !== file.contentBase64) {
        throw new Error("WORKFLOW_BUNDLE_CANDIDATE_FILE_BASE64_INVALID");
      }
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (jsonDigest(content) !== file.contentSha256) {
        throw new Error("WORKFLOW_BUNDLE_CANDIDATE_FILE_DIGEST_MISMATCH");
      }
      return {
        path: file.path,
        mode: file.mode,
        content,
        contentSha256: file.contentSha256,
      };
    } finally {
      bytes.fill(0);
    }
  });
}
