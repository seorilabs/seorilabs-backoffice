import { observeApprovalRun } from "@/lib/deployment-approvals/monitor";
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
  destinationOrFallback,
  notificationDestinations,
} from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { issueEventReport } from "@/lib/notifications/issue-events";
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

// 실시간 webhook 에서만(미러 backfill 아님) Slack 알림. 실패해도 webhook 200 유지.
async function notifyHooks(event: string, p: WebhookPayload): Promise<void> {
  try {
    const repoFullName = p.repository?.full_name ?? "";
    const app = repoFullName
      ? await prisma.app.findUnique({
          where: { repoFullName },
          select: { status: true, displayName: true },
        })
      : null;
    if (app && isDisabledAppStatus(app.status)) return;
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
          dedupeKey: `github-approval:${repoFullName}:${p.issue.number}:${gate}:${p.issue.updated_at}`,
          kind: "OPS_ALERT",
          payload: {
            text: `${gate === "release" ? "🚀" : "📝"} **승인 필요** ${repo} #${p.issue.number}\n${p.issue.title}`,
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 3,
                    label: `승인 (${gate})`,
                    custom_id: `approval:${gate}:${mir.id}`,
                  },
                ],
              },
            ],
            // 버튼은 상자 없이도 그대로 실린다. 승인 대기는 하루에 여러 건 쌓이므로
            // 두 줄마다 상자를 그리면 채널이 카드 더미가 된다.
            plain: true,
          },
          destinations: notificationDestinations(["backoffice"]),
        });
      }
    }
    // 관측은 미러·내부 이벤트에 보존하고 중요한 개발 사건만 보고한다.
    if (
      event === "issues" &&
      (p.action === "opened" || p.action === "closed") &&
      p.issue
    ) {
      const labels = normalizeLabels(
        p.issue.labels as unknown as Array<string | { name?: string }>,
      );
      const report = issueEventReport({
        action: p.action,
        repoFullName,
        appName: app?.displayName ?? repo,
        number: p.issue.number,
        title: p.issue.title,
        priority: priorityFromLabels(labels),
        stateReason: p.issue.state_reason,
        updatedAt: p.issue.updated_at,
      });
      await enqueueNotification({
        ...report,
        kind: "OPS_ALERT",
        destinations:
          report.payload.report.category === "change"
            ? destinationOrFallback("github-issues", "backoffice")
            : [],
      });
    }
  } catch (e) {
    console.error("[slack] notifyHooks error:", e);
  }
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
      if (repo === "seorilabs/platform" && p.workflow_run)
        await observeApprovalRun(p.workflow_run.id);
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
  const stableTagObservation =
    event === "push" ? durableStableTagPush(payload) : null;
  const discoveryObservation = durableRepositoryDiscovery({
    event,
    action: payload.action,
    repository: payload.repository as
      | Partial<RepositoryWebhookInput>
      | undefined,
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
    occurredAt: payload.issue?.updated_at
      ? new Date(payload.issue.updated_at)
      : undefined,
    issue: payload.issue ? durableIssueObservation(payload.issue) : undefined,
    stableTagPush: stableTagObservation,
    repositoryDiscovery: discoveryObservation,
  });
  if (stableTagObservation || discoveryObservation) {
    // 응답 이후 exact sourceKey를 즉시 소진한다. 실패하거나 process가 종료돼도
    // durable inbox의 FAILED/PENDING row를 scheduler 또는 GitHub 재전송이 재생한다.
    after(async () => {
      try {
        await drainAutomationIngress({
          sourceKey: `github:${deliveryId}`,
          limit: 1,
        });
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
    console.error(
      `[webhook] ${event} handler error code=MIRROR_HANDLER_FAILED`,
    );
  }

  await notifyHooks(event, payload);

  return NextResponse.json({ status: "ok" });
}
