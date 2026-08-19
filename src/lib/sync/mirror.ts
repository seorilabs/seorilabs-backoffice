import { prisma } from "@/lib/prisma";
import type {
  IssueState,
  PrState,
  ReleaseMarket,
} from "@prisma/client";
import {
  normalizeLabels,
  priorityFromLabels,
  isAutopilot,
  hasEvidence,
  isBlocked,
} from "@/lib/domain/labels";
import { marketFromWorkflowName } from "@/lib/domain/lifecycle";
import { releaseStatusOf } from "@/lib/sync/release-status";
import { recordTransition } from "@/lib/sync/transition";
import { findTagForSha } from "@/lib/github/release";
import {
  enqueueDeployAllResultNotification,
  enqueueDeployCompletionNotification,
} from "@/lib/notifications/deploy-enqueue";
import { buildDeployAllStatusCardText } from "@/lib/notifications/deploy-format";
import { isDeployAllWorkflow } from "@/lib/core/deploy-targets";

// ── 공통 입력 타입 (webhook payload 와 REST list 응답의 교집합) ─────────────
export interface GhIssueInput {
  number: number;
  node_id: string;
  title: string;
  state: string;
  state_reason?: string | null;
  body?: string | null;
  user?: { login?: string | null } | null;
  assignees?: Array<{ login: string }> | null;
  labels?: Array<string | { name?: string | null }> | null;
  milestone?: { title?: string | null } | null;
  pull_request?: unknown;
  created_at: string;
  updated_at: string;
}

export interface GhPrInput {
  number: number;
  node_id: string;
  title: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  body?: string | null;
  user?: { login?: string | null } | null;
  labels?: Array<string | { name?: string | null }> | null;
  head?: { ref?: string | null } | null;
  base?: { ref?: string | null } | null;
  created_at: string;
  updated_at: string;
}

export interface GhRunInput {
  id: number;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  event?: string | null;
  path?: string | null;
  head_sha?: string | null;
  head_branch?: string | null;
  run_attempt?: number | null;
  run_started_at?: string | null;
  updated_at: string;
}

const BO_MARKER = /<!--\s*bo:req=([0-9a-fA-F-]+)\s*-->/;

async function resolveAppId(repoFullName: string): Promise<string | null> {
  const app = await prisma.app.findUnique({
    where: { repoFullName },
    select: { id: true },
  });
  return app?.id ?? null;
}

// ── Issue ───────────────────────────────────────────────────────────────────
export async function upsertIssue(
  repoFullName: string,
  gh: GhIssueInput,
): Promise<void> {
  if (gh.pull_request) return; // PR 은 issue 미러에서 제외
  const ghUpdatedAt = new Date(gh.updated_at);
  const existing = await prisma.issueMirror.findUnique({
    where: { nodeId: gh.node_id },
    select: { ghUpdatedAt: true },
  });
  if (existing && existing.ghUpdatedAt > ghUpdatedAt) return; // stale 이벤트 무시

  const labels = normalizeLabels(gh.labels);
  const marker = gh.body?.match(BO_MARKER);
  const appId = await resolveAppId(repoFullName);

  const data = {
    appId,
    repoFullName,
    number: gh.number,
    title: gh.title,
    state: (gh.state.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN") as IssueState,
    stateReason: gh.state_reason ?? null,
    authorLogin: gh.user?.login ?? null,
    assignees: (gh.assignees ?? []).map((a) => a.login),
    labels,
    milestone: gh.milestone?.title ?? null,
    priority: priorityFromLabels(labels),
    isAutopilot: isAutopilot(labels),
    hasEvidence: hasEvidence(labels),
    isBlocked: isBlocked(labels),
    source: marker ? ("BACKOFFICE" as const) : ("UNKNOWN" as const),
    clientReqId: marker ? marker[1] : null,
    ghCreatedAt: new Date(gh.created_at),
    ghUpdatedAt,
  };

  await prisma.issueMirror.upsert({
    where: { nodeId: gh.node_id },
    create: { nodeId: gh.node_id, ...data },
    update: data,
  });
}

// ── Pull Request ──────────────────────────────────────────────────────────────
function parseLinkedIssue(body?: string | null): number | null {
  if (!body) return null;
  const m = body.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
  return m ? Number(m[1]) : null;
}

export async function upsertPr(
  repoFullName: string,
  gh: GhPrInput,
): Promise<void> {
  const ghUpdatedAt = new Date(gh.updated_at);
  const existing = await prisma.pullRequestMirror.findUnique({
    where: { nodeId: gh.node_id },
    select: { ghUpdatedAt: true },
  });
  if (existing && existing.ghUpdatedAt > ghUpdatedAt) return;

  const labels = normalizeLabels(gh.labels);
  const merged = gh.merged === true || !!gh.merged_at;
  const state: PrState = merged
    ? "MERGED"
    : gh.state.toUpperCase() === "CLOSED"
      ? "CLOSED"
      : "OPEN";
  const headRef = gh.head?.ref ?? null;
  const appId = await resolveAppId(repoFullName);

  const data = {
    appId,
    repoFullName,
    number: gh.number,
    title: gh.title,
    state,
    isDraft: gh.draft ?? false,
    authorLogin: gh.user?.login ?? null,
    headRef,
    baseRef: gh.base?.ref ?? null,
    labels,
    linkedIssue: parseLinkedIssue(gh.body),
    isAutopilotPr: isAutopilot(labels) || (headRef?.startsWith("issue/") ?? false),
    mergedAt: gh.merged_at ? new Date(gh.merged_at) : null,
    ghCreatedAt: new Date(gh.created_at),
    ghUpdatedAt,
  };

  await prisma.pullRequestMirror.upsert({
    where: { nodeId: gh.node_id },
    create: { nodeId: gh.node_id, ...data },
    update: data,
  });
}

// 버전: head_branch 가 태그면 그대로, 아니면(main 등) head_sha 를 가리키는
// v* 태그를 GitHub 에서 조회해 보정. 태그가 없으면 "untagged".
async function resolveRunVersion(repoFullName: string, gh: GhRunInput): Promise<string> {
  if (gh.head_branch && /^v\d/.test(gh.head_branch)) return gh.head_branch;
  if (gh.head_sha) return (await findTagForSha(repoFullName, gh.head_sha)) ?? "untagged";
  return "untagged";
}

// ── Workflow run → ReleaseRecord + 라이프사이클 자동 신호 ──────────────────────
export async function upsertWorkflowRun(
  repoFullName: string,
  gh: GhRunInput,
): Promise<void> {
  const ghUpdatedAt = new Date(gh.updated_at);
  const runId = BigInt(gh.id);
  const existing = await prisma.workflowRunMirror.findUnique({
    where: { runId },
    select: { ghUpdatedAt: true },
  });
  if (existing && existing.ghUpdatedAt > ghUpdatedAt) return;

  const appId = await resolveAppId(repoFullName);
  const runData = {
    appId,
    repoFullName,
    name: gh.name ?? null,
    status: gh.status ?? "unknown",
    conclusion: gh.conclusion ?? null,
    event: gh.event ?? null,
    headSha: gh.head_sha ?? null,
    headBranch: gh.head_branch ?? null,
    runAttempt: gh.run_attempt ?? 1,
    runStartedAt: gh.run_started_at ? new Date(gh.run_started_at) : null,
    ghUpdatedAt,
  };
  await prisma.workflowRunMirror.upsert({
    where: { runId },
    create: { runId, ...runData },
    update: runData,
  });

  if (!appId) return;
  const status = releaseStatusOf(gh.status, gh.conclusion);
  const runAttempt = gh.run_attempt ?? 1;
  const runUrl = `https://github.com/${repoFullName}/actions/runs/${runId}`;

  // deploy-* 워크플로면 ReleaseRecord 파생 (R1: GitHub Release 객체 없음).
  const market = marketFromWorkflowName(gh.name);
  if (!market) {
    // deploy-all 의 마켓 잡은 재사용 워크플로라 자체 workflow_run 이 없다. ReleaseRecord 도
    // 파생되지 않아 그대로 두면 ALL 배포는 성공이든 실패든 Discord 에 아무것도 남지 않는다.
    if (isDeployAllWorkflow(gh.path) && (status === "SUCCEEDED" || status === "FAILED")) {
      const app = await prisma.app.findUnique({
        where: { id: appId },
        select: { displayName: true },
      });
      await enqueueDeployAllResultNotification({
        text: buildDeployAllStatusCardText({
          displayName: app?.displayName ?? repoFullName,
          version: await resolveRunVersion(repoFullName, gh),
          status,
          runUrl,
          updatedAt: ghUpdatedAt,
        }),
        eventKey: `${runId}:${runAttempt}`,
        occurredAt: ghUpdatedAt,
      });
    }
    return;
  }

  const version = await resolveRunVersion(repoFullName, gh);
  const relData = {
    appId,
    version,
    track: null,
    status,
    workflowName: gh.name ?? null,
    commitSha: gh.head_sha ?? null,
    deployedAt: status === "SUCCEEDED" ? ghUpdatedAt : null,
  };
  const release = await prisma.releaseRecord.upsert({
    where: { market_workflowRunId: { market, workflowRunId: runId } },
    create: { market, workflowRunId: runId, ...relData },
    update: relData,
  });

  // webhook 유실·처리 실패도 정기 reconcile 이 복구하도록 미러 upsert 경로에서 outbox를 만든다.
  // terminal key는 기존 완료 알림과 같게 유지해 배포 직후 과거 실행을 다시 보내지 않는다.
  // 비terminal 상태는 상태명을 붙여 같은 실행의 요청됨→진행 중 카드를 멱등 갱신한다.
  const terminal = status === "SUCCEEDED" || status === "FAILED";
  await enqueueDeployCompletionNotification({
    releaseRecordId: release.id,
    eventKey: terminal
      ? `github:${runId}:${runAttempt}`
      : `github:${runId}:${runAttempt}:${status.toLowerCase()}`,
    status,
    runUrl,
  });

  if (status === "SUCCEEDED") {
    await evaluateLifecycleOnSuccessfulRelease(appId, `workflow_run:${runId}`);
  }
}

// 배포 성공 시 라이프사이클 자동 전이 (라벨/마일스톤 비의존).
export async function evaluateLifecycleOnSuccessfulRelease(
  appId: string,
  signalRef: string,
): Promise<void> {
  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: { currentStage: true, marketTargets: true },
  });
  if (!app) return;

  if (app.currentStage === "MARKET_SUBMISSION") {
    await recordTransition({
      appId,
      to: "RELEASE",
      source: "SYSTEM",
      reason: "마켓 배포 성공",
      signalRef,
    });
  }

  // RELEASE → LIVEOPS: 전 marketTargets 가 한번이라도 SUCCEEDED 인 경우.
  const refreshed = await prisma.app.findUnique({
    where: { id: appId },
    select: { currentStage: true, marketTargets: true },
  });
  if (!refreshed || refreshed.currentStage !== "RELEASE") return;

  const targets = toMarketEnums(refreshed.marketTargets);
  if (targets.length === 0) return;
  const succeeded = await prisma.releaseRecord.findMany({
    where: { appId, status: "SUCCEEDED" },
    select: { market: true },
    distinct: ["market"],
  });
  const succeededSet = new Set(succeeded.map((r) => r.market));
  if (targets.every((m) => succeededSet.has(m))) {
    await recordTransition({
      appId,
      to: "LIVEOPS",
      source: "SYSTEM",
      reason: "전 마켓 배포 성공",
      signalRef,
    });
  }
}

function toMarketEnums(marketTargets: unknown): ReleaseMarket[] {
  if (!Array.isArray(marketTargets)) return [];
  const map: Record<string, ReleaseMarket> = {
    play: "PLAY",
    appstore: "APPSTORE",
    ait: "AIT",
    web: "WEB",
  };
  const out: ReleaseMarket[] = [];
  for (const t of marketTargets) {
    const m = map[String(t).toLowerCase()];
    // WEB 은 배포 신호가 없으므로 LIVEOPS 게이트에서 제외 (H3).
    if (m && m !== "WEB") out.push(m);
  }
  return out;
}
