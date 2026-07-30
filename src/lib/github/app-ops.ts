import {
  APP_OPS_WORKFLOW_FILE,
  artifactName,
  isAppOpsRequestId,
  type AppOpsResult,
} from "@/lib/app-ops/execution";
import { parseAppOpsResultArtifact } from "@/lib/app-ops/artifact";
import { getInstallationOctokit } from "@/lib/github/app";
import { dispatchWorkflow } from "@/lib/github/write";

const MAX_ARTIFACT_BYTES = 512 * 1024;
const REQUEST_ID_IN_TITLE =
  /\[([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]$/i;

function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

export interface AppOpsRunSummary {
  requestId: string;
  operation: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  runId: number;
}

export interface AppOpsRunStatus extends AppOpsRunSummary {
  result?: AppOpsResult;
  resultError?: string;
}

function runSummary(run: {
  id: number;
  display_title?: string | null;
  status?: string | null;
  conclusion?: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}): AppOpsRunSummary | null {
  const title = run.display_title ?? "";
  const match = REQUEST_ID_IN_TITLE.exec(title);
  if (!match?.[1]) return null;
  const requestId = match[1];
  const operation = title
    .replace(/^Backoffice\s*[·:-]\s*/i, "")
    .replace(/\s*\[[^\]]+\]$/, "")
    .trim();
  return {
    requestId,
    operation: operation || "알 수 없는 오퍼레이션",
    status: run.status ?? "unknown",
    conclusion: run.conclusion ?? null,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    url: run.html_url,
    runId: run.id,
  };
}

export async function getRepoDefaultBranch(repoFullName: string): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  const response = await octokit.rest.repos.get({ owner, repo });
  return response.data.default_branch;
}

export async function dispatchAppOpsWorkflow(options: {
  repoFullName: string;
  ref: string;
  operation: string;
  requestId: string;
  targetRef: string;
  reason: string;
}): Promise<void> {
  await dispatchWorkflow({
    repoFullName: options.repoFullName,
    workflowFile: APP_OPS_WORKFLOW_FILE,
    ref: options.ref,
    inputs: {
      operation: options.operation,
      request_id: options.requestId,
      target_ref: options.targetRef,
      reason: options.reason,
    },
  });
}

export async function listRecentAppOpsRuns(
  repoFullName: string,
  limit = 10,
): Promise<AppOpsRunSummary[]> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  try {
    const response = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: APP_OPS_WORKFLOW_FILE,
      event: "workflow_dispatch",
      per_page: Math.min(Math.max(limit * 3, 20), 100),
    });
    return response.data.workflow_runs
      .map(runSummary)
      .filter((run): run is AppOpsRunSummary => Boolean(run))
      .slice(0, limit);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return [];
    throw error;
  }
}

export async function getAppOpsRunStatus(
  repoFullName: string,
  requestId: string,
): Promise<AppOpsRunStatus | null> {
  if (!isAppOpsRequestId(requestId)) throw new Error("요청 ID가 올바르지 않습니다.");
  const runs = await listRecentAppOpsRuns(repoFullName, 30);
  const summary = runs.find((run) => run.requestId === requestId);
  if (!summary) return null;
  if (summary.status !== "completed") return summary;

  try {
    const result = await downloadRunResult(repoFullName, summary.runId, requestId);
    return { ...summary, result };
  } catch (error) {
    return { ...summary, resultError: (error as Error).message };
  }
}

async function downloadRunResult(
  repoFullName: string,
  runId: number,
  requestId: string,
): Promise<AppOpsResult> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  const artifacts = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: runId,
    per_page: 100,
  });
  const expectedName = artifactName(requestId);
  const artifact = artifacts.data.artifacts.find(
    (candidate) => candidate.name === expectedName && !candidate.expired,
  );
  if (!artifact) throw new Error("결과 artifact가 아직 없거나 만료됐습니다.");
  if (artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
    throw new Error("결과 artifact가 허용 크기를 초과했습니다.");
  }

  const response = await octokit.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: artifact.id,
    archive_format: "zip",
  });
  const raw = response.data as unknown;
  const zipBytes =
    raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : raw instanceof Uint8Array
        ? raw
        : null;
  if (!zipBytes) throw new Error("결과 artifact 형식을 읽을 수 없습니다.");
  return parseAppOpsResultArtifact(zipBytes, requestId);
}
