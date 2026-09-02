import { after, NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/github/webhook";
import { prisma } from "@/lib/prisma";
import {
  upsertIssue,
  upsertPr,
  upsertWorkflowRun,
  type GhIssueInput,
  type GhPrInput,
  type GhRunInput,
} from "@/lib/sync/mirror";
import {
  discordDestinationOrFallback,
  discordDestinations,
} from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { issueEventMessage } from "@/lib/notifications/issue-events";
import { planIssueThread } from "@/lib/notifications/issue-thread";
import { listIssueComments } from "@/lib/github/read";
import { normalizeLabels, priorityFromLabels } from "@/lib/domain/labels";
import { isDisabledAppStatus } from "@/lib/domain/app-visibility";
import { env } from "@/lib/env";
import { getInstallationOctokit } from "@/lib/github/app";
import {
  isPlatformRegistryPush,
  syncPlatformRegistryBindings,
} from "@/lib/platform/registry-bindings";
import type { RepositoryWebhookInput } from "@/lib/control-plane/repository-registration";
import {
  drainAutomationIngress,
  recordWebhookDelivery,
} from "@/lib/control-plane/automation-service";
import { reconcileTerminalRepoGuards } from "@/lib/control-plane/agent-queue";
import {
  durableIssueObservation,
  durableRepositoryDiscovery,
  durableStableTagPush,
} from "@/lib/control-plane/automation-inbox";
import { durableWorkflowBundleCandidate } from "@/lib/control-plane/workflow-bundle-candidate-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WebhookPayload {
  action?: string;
  ref?: string;
  created?: boolean;
  deleted?: boolean;
  after?: string;
  repository?: Partial<RepositoryWebhookInput>;
  issue?: GhIssueInput;
  pull_request?: GhPrInput;
  workflow_run?: GhRunInput;
  label?: { name?: string };
}

// 실시간 webhook 에서만(미러 backfill 아님) Discord 알림. 실패해도 webhook 200 유지.
async function shouldNotifyRepo(repoFullName: string): Promise<boolean> {
  const app = await prisma.app.findUnique({
    where: { repoFullName },
    select: { status: true },
  });
  return !app || !isDisabledAppStatus(app.status);
}

async function notifyHooks(event: string, p: WebhookPayload, deliveryId: string): Promise<void> {
  try {
    const repoFullName = p.repository?.full_name ?? "";
    if (repoFullName && !(await shouldNotifyRepo(repoFullName))) return;
    const repo = repoFullName.replace("seorilabs/", "");
    if (
      event === "issues" &&
      p.action === "labeled" &&
      p.label?.name?.startsWith("approval:") &&
      p.issue
    ) {
      const gate = p.label.name === "approval:release" ? "release" : "planning";
      const mir = await prisma.issueMirror.findUnique({
        where: { nodeId: p.issue.node_id },
        select: { id: true },
      });
      if (mir) {
        await enqueueNotification({
          dedupeKey: `github:${deliveryId}:approval`,
          kind: "OPS_ALERT",
          payload: {
            text: `${gate === "release" ? "🚀" : "📝"} **승인 필요** ${repo} #${p.issue.number}\n${p.issue.title}`,
            components: [{ type: 1, components: [{ type: 2, style: 3, label: `승인 (${gate})`, custom_id: `approval:${gate}:${mir.id}` }] }],
          },
          destinations: discordDestinations(["backoffice"]),
        });
      }
    }
    // 이슈 생성·종료 → 즉시 알림. 등급과 무관하게 전체 이슈를 알린다.
    if (event === "issues" && (p.action === "opened" || p.action === "closed") && p.issue) {
      const labels = normalizeLabels(p.issue.labels as unknown as Array<string | { name?: string }>);
      const parentDedupeKey = `github:${deliveryId}:issue-${p.action}`;
      const destinations = discordDestinationOrFallback("github-issues", "backoffice");
      await enqueueNotification({
        dedupeKey: parentDedupeKey,
        kind: "OPS_ALERT",
        payload: {
          text: issueEventMessage({
            action: p.action,
            repoFullName,
            number: p.issue.number,
            title: p.issue.title,
            priority: priorityFromLabels(labels),
            stateReason: p.issue.state_reason,
          }),
        },
        // 전체 이슈가 흐르는 알림이라 버튼 카드가 놓이는 #backoffice 와 분리한다.
        // 전용 채널을 아직 설정하지 않았으면 기존 채널로 계속 보낸다.
        destinations,
      });
      await enqueueIssueThread({
        parentDedupeKey,
        destinations,
        repo,
        issue: p.issue,
        action: p.action,
      });
    }
  } catch (e) {
    console.error("[discord] notifyHooks error:", e);
  }
}

/** 이슈 알림에 딸릴 쓰레드를 예약한다. 판단은 planIssueThread 가 하고 여기선 배선만 한다. */
async function enqueueIssueThread(input: {
  parentDedupeKey: string;
  destinations: ReturnType<typeof discordDestinations>;
  repo: string;
  issue: GhIssueInput;
  action: "opened" | "closed";
}): Promise<void> {
  const repoFullName = `seorilabs/${input.repo}`;
  const plan = await planIssueThread(
    {
      action: input.action,
      parentDedupeKey: input.parentDedupeKey,
      repo: input.repo,
      number: input.issue.number,
      title: input.issue.title,
      body: input.issue.body,
      stateReason: input.issue.state_reason,
    },
    {
      findOpenedThreadKey: async (threadName) =>
        (
          await prisma.notificationDelivery.findFirst({
            where: {
              provider: "DISCORD",
              status: "SENT",
              deletedAt: null,
              providerMessageId: { not: null },
              event: { payload: { path: "$.thread.threadName", equals: threadName } },
            },
            select: { event: { select: { dedupeKey: true } } },
          })
        )?.event.dedupeKey ?? null,
      listComments: () =>
        listIssueComments(repoFullName, input.issue.number).catch((error) => {
          // 댓글을 못 읽어도 PR 링크만으로 쓰레드를 남긴다.
          console.error("[discord] 이슈 댓글 조회 실패:", error instanceof Error ? error.message : error);
          return [];
        }),
      listLinkedPulls: async () =>
        (
          await prisma.pullRequestMirror.findMany({
            where: { repoFullName, linkedIssue: input.issue.number },
            orderBy: { number: "asc" },
            select: { number: true, title: true, state: true },
          })
        ).map((pull) => ({
          number: pull.number,
          title: pull.title,
          url: `https://github.com/${repoFullName}/pull/${pull.number}`,
          merged: pull.state === "MERGED",
        })),
    },
  );
  if (!plan) return;
  await enqueueNotification({
    dedupeKey: plan.dedupeKey,
    kind: "OPS_ALERT",
    payload: {
      text: plan.text,
      thread: { parentDedupeKey: plan.parentDedupeKey, threadName: plan.threadName },
    },
    destinations: input.destinations,
  });
}

function repoName(p: WebhookPayload): string | null {
  return p.repository?.full_name ?? null;
}

async function handleEvent(event: string, p: WebhookPayload): Promise<void> {
  const repo = repoName(p);
  if (!repo) return;
  switch (event) {
    case "issues":
      if (p.issue) await upsertIssue(repo, p.issue);
      break;
    case "pull_request":
      if (p.pull_request) {
        await upsertPr(repo, p.pull_request);
        await reconcileTerminalRepoGuards({
          repoFullName: repo,
          pullRequestNumber: p.pull_request.number,
        });
      }
      break;
    case "workflow_run":
      if (p.workflow_run) await upsertWorkflowRun(repo, p.workflow_run);
      break;
    case "push": {
      if (isPlatformRegistryPush(repo, p.ref ?? "", env.githubOrg())) {
        after(async () => {
          try {
            await syncPlatformRegistryBindings(
              await getInstallationOctokit(),
              env.githubOrg(),
            );
          } catch (e) {
            console.error("[webhook] Platform registry binding 실패:", e);
          }
        });
      }
      break;
    }
    default:
      // issue_comment 등은 미러 대상 아님.
      break;
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";

  if (!verifyWebhookSignature(raw, sig, secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const deliveryId = req.headers.get("x-github-delivery") ?? "";
  const event = req.headers.get("x-github-event") ?? "";
  if (!deliveryId) {
    return NextResponse.json({ error: "missing delivery id" }, { status: 400 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw) as WebhookPayload;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // delivery와 automation inbox를 같은 transaction에 기록한다. handler가 실패해도
  // scheduler가 inbox를 재처리하며 동일 delivery 재전송은 한 번만 enqueue된다.
  const stableTagObservation = event === "push" ? durableStableTagPush(payload) : null;
  const workflowBundleCandidate = durableWorkflowBundleCandidate({
    event,
    action: payload.action,
    repository: payload.repository,
    workflowRun: payload.workflow_run,
  });
  const discoveryObservation = durableRepositoryDiscovery({
    event,
    action: payload.action,
    repository: payload.repository as Partial<RepositoryWebhookInput> | undefined,
    ref: payload.ref,
    after: payload.after,
    organization: env.githubOrg(),
  });
  const delivery = await recordWebhookDelivery({
    deliveryId,
    event,
    action: payload.action,
    repoFullName: payload.repository?.full_name,
    issueNumber: payload.issue?.number,
    issueNodeId: payload.issue?.node_id,
    occurredAt: payload.issue?.updated_at ? new Date(payload.issue.updated_at) : undefined,
    issue: payload.issue ? durableIssueObservation(payload.issue) : undefined,
    stableTagPush: stableTagObservation,
    repositoryDiscovery: discoveryObservation,
    workflowBundleCandidate,
  });
  if (stableTagObservation || discoveryObservation || workflowBundleCandidate) {
    // 응답 이후 exact sourceKey를 즉시 소진한다. 실패하거나 process가 종료돼도
    // durable inbox의 FAILED/PENDING row를 scheduler 또는 GitHub 재전송이 재생한다.
    after(async () => {
      try {
        await drainAutomationIngress({ sourceKey: `github:${deliveryId}`, limit: 1 });
      } catch (e) {
        console.error(
          "[webhook] automation inbox 처리 실패:",
          e instanceof Error ? e.message : e,
        );
      }
    });
  }
  if (delivery.duplicate) {
    return NextResponse.json({ status: "duplicate" });
  }

  try {
    await handleEvent(event, payload);
  } catch {
    // 기존 mirror upsert는 provider 재동기화 경계가 있으므로 webhook 응답을 유지한다.
    console.error(`[webhook] ${event} handler error code=MIRROR_HANDLER_FAILED`);
  }

  await notifyHooks(event, payload, deliveryId);

  return NextResponse.json({ status: "ok" });
}
