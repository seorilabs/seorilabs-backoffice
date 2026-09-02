import { z } from "zod";

import type { GhRunInput } from "@/lib/sync/mirror";

export const WORKFLOW_BUNDLE_CANDIDATE_SOURCE = {
  registryId: "seorilabs-workflow-bundles-v5",
  repository: "seorilabs/.github",
  repositoryId: "1241442018",
  workflowPath: ".github/workflows/workflow-bundle-v5-candidate.yml",
} as const;

export const durableWorkflowBundleCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("WORKFLOW_BUNDLE_CANDIDATE"),
  repositoryId: z.literal(WORKFLOW_BUNDLE_CANDIDATE_SOURCE.repositoryId),
  repository: z.literal(WORKFLOW_BUNDLE_CANDIDATE_SOURCE.repository),
  workflowPath: z.literal(WORKFLOW_BUNDLE_CANDIDATE_SOURCE.workflowPath),
  eventName: z.enum(["push", "workflow_dispatch"]),
  headBranch: z.literal("main"),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  runId: z.string().regex(/^[1-9][0-9]{0,15}$/).refine((value) => Number.isSafeInteger(Number(value))),
  runAttempt: z.number().int().positive().safe(),
}).strict();

export type DurableWorkflowBundleCandidate = z.infer<typeof durableWorkflowBundleCandidateSchema>;

/** 완료 알림은 후보 수집 신호일 뿐이다. 승인과 artifact 신뢰는 원장 import가 검증한다. */
export function durableWorkflowBundleCandidate(input: {
  event: string;
  action?: string | null;
  repository?: { id?: number; full_name?: string } | null;
  workflowRun?: Partial<GhRunInput> | null;
}): DurableWorkflowBundleCandidate | null {
  const run = input.workflowRun;
  if (
    input.event !== "workflow_run"
    || input.action !== "completed"
    || String(input.repository?.id) !== WORKFLOW_BUNDLE_CANDIDATE_SOURCE.repositoryId
    || input.repository?.full_name !== WORKFLOW_BUNDLE_CANDIDATE_SOURCE.repository
    || run?.status !== "completed"
    || run.conclusion !== "success"
    || !Number.isSafeInteger(run.id)
  ) return null;
  const parsed = durableWorkflowBundleCandidateSchema.safeParse({
    schemaVersion: 1,
    kind: "WORKFLOW_BUNDLE_CANDIDATE",
    repositoryId: String(input.repository.id),
    repository: input.repository.full_name,
    workflowPath: run.path,
    eventName: run.event,
    headBranch: run.head_branch,
    sourceSha: typeof run.head_sha === "string" ? run.head_sha.toLowerCase() : undefined,
    runId: String(run.id),
    runAttempt: run.run_attempt,
  });
  return parsed.success ? parsed.data : null;
}

export function workflowBundleCandidateSourceKey(observation: DurableWorkflowBundleCandidate): string {
  return `reconcile:workflow-bundle:${observation.runId}:${observation.runAttempt}`;
}
