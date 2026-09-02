import { prisma } from "@/lib/prisma";
import { getInstallationOctokit } from "@/lib/github/app";
import {
  upsertIssue,
  upsertPr,
  upsertWorkflowRun,
  type GhIssueInput,
  type GhPrInput,
  type GhRunInput,
} from "@/lib/sync/mirror";
import { env } from "@/lib/env";
import { syncPlatformRegistryBindings } from "@/lib/platform/registry-bindings";
import { reconcileRepositoryWhere } from "@/lib/sync/reconcile-scope";
import { backfillWorkflowBundleCandidates } from "@/lib/control-plane/workflow-bundle-candidate-sync";

// 한 레포의 issue/PR/workflow_run 을 installation token 으로 증분 동기화.
export async function backfillRepo(repoFullName: string): Promise<void> {
  const octokit = await getInstallationOctokit();
  const [owner, repo] = repoFullName.split("/");
  const cursor = await prisma.syncCursor.findUnique({ where: { repoFullName } });

  // Issues (PR 포함 — upsertIssue 가 PR 스킵).
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    per_page: 100,
    ...(cursor?.lastIssueSync
      ? { since: cursor.lastIssueSync.toISOString() }
      : {}),
  });
  for (const i of issues) {
    await upsertIssue(repoFullName, i as unknown as GhIssueInput);
  }

  // Pull requests.
  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "all",
    per_page: 100,
  });
  for (const p of prs) {
    await upsertPr(repoFullName, p as unknown as GhPrInput);
  }

  // 최근 workflow runs (출시 신호; 전체 이력은 불필요).
  const runsRes = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    per_page: 50,
  });
  for (const r of runsRes.data.workflow_runs) {
    await upsertWorkflowRun(repoFullName, r as unknown as GhRunInput);
  }

  const now = new Date();
  await prisma.syncCursor.upsert({
    where: { repoFullName },
    create: {
      repoFullName,
      lastIssueSync: now,
      lastPrSync: now,
      lastRunSync: now,
    },
    update: { lastIssueSync: now, lastPrSync: now, lastRunSync: now },
  });
}

// 전체 reconcile. Kubernetes CronJob의 concurrencyPolicy=Forbid가 예약 실행을
// 직렬화하고, 이 guard는 같은 HTTP 프로세스에 들어온 중복 요청을 한 번 더 막는다.
let running = false;

export interface ReconcileRunResult {
  repos: number;
  succeeded: number;
  failed: number;
  state: "completed" | "busy" | "partial";
  ok: boolean;
}

export async function reconcileAll(): Promise<ReconcileRunResult> {
  if (running) {
    return { repos: 0, succeeded: 0, failed: 0, state: "busy", ok: false };
  }
  running = true;
  try {
    const repositories = await prisma.repositoryRegistration.findMany({
      where: reconcileRepositoryWhere,
      orderBy: { repoFullName: "asc" },
      select: { repoFullName: true },
    });
    let succeeded = 0;
    let failed = 0;
    try {
      await backfillWorkflowBundleCandidates();
    } catch (error) {
      failed += 1;
      console.error("[reconcile] 공통 빌드 후보 수집 실패:", error instanceof Error ? error.message : "CANDIDATE_BACKFILL_FAILED");
    }
    for (const repository of repositories) {
      try {
        await backfillRepo(repository.repoFullName);
        succeeded++;
      } catch (e) {
        failed++;
        console.error(`[reconcile] ${repository.repoFullName} 실패:`, e);
      }
    }
    try {
      await syncPlatformRegistryBindings(
        await getInstallationOctokit(),
        env.githubOrg(),
      );
    } catch (e) {
      failed++;
      console.error("[reconcile] Platform registry binding 실패:", e);
    }
    return {
      repos: repositories.length,
      succeeded,
      failed,
      state: failed === 0 ? "completed" : "partial",
      ok: failed === 0,
    };
  } finally {
    running = false;
  }
}
