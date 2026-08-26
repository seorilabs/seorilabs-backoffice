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

// 전체 reconcile. 단일 replica(Recreate)라 in-process guard 로 중복 실행만 방지.
let running = false;

export async function reconcileAll(): Promise<{ repos: number; ok: boolean }> {
  if (running) return { repos: 0, ok: false };
  running = true;
  try {
    const apps = await prisma.app.findMany({ select: { repoFullName: true } });
    for (const a of apps) {
      try {
        await backfillRepo(a.repoFullName);
      } catch (e) {
        console.error(`[reconcile] ${a.repoFullName} 실패:`, e);
      }
    }
    try {
      await syncPlatformRegistryBindings(
        await getInstallationOctokit(),
        env.githubOrg(),
      );
    } catch (e) {
      console.error("[reconcile] Platform registry binding 실패:", e);
    }
    return { repos: apps.length, ok: true };
  } finally {
    running = false;
  }
}
