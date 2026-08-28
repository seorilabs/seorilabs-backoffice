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
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { issueEventMessage } from "@/lib/notifications/issue-events";
import { normalizeLabels, priorityFromLabels } from "@/lib/domain/labels";
import { isDisabledAppStatus } from "@/lib/domain/app-visibility";
import { env } from "@/lib/env";
import { getInstallationOctokit } from "@/lib/github/app";
import {
  isPlatformRegistryPush,
  syncPlatformRegistryBindings,
} from "@/lib/platform/registry-bindings";
import {
  registerRepositoryWebhook,
  type RepositoryWebhookInput,
} from "@/lib/control-plane/repository-registration";
import {
  drainAutomationIngress,
  recordWebhookDelivery,
} from "@/lib/control-plane/automation-service";
import { reconcileTerminalRepoGuards } from "@/lib/control-plane/agent-queue";
import {
  durableIssueObservation,
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
      await enqueueNotification({
        dedupeKey: `github:${deliveryId}:issue-${p.action}`,
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
        destinations: discordDestinations(["backoffice"]),
      });
    }
  } catch (e) {
    console.error("[discord] notifyHooks error:", e);
  }
}

function repoName(p: WebhookPayload): string | null {
  return p.repository?.full_name ?? null;
}

async function handleEvent(event: string, p: WebhookPayload, deliveryId: string): Promise<void> {
  const repo = repoName(p);
  if (!repo) return;
  if (
    p.repository?.id &&
    p.repository.full_name &&
    (event === "push" || event === "repository")
  ) {
    await registerRepositoryWebhook({
      event,
      action: p.action,
      repository: p.repository as RepositoryWebhookInput,
      ref: p.ref,
      after: p.after,
      deliveryId,
      organization: env.githubOrg(),
    });
  }
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
  });
  if (stableTagObservation) {
    // 응답 이후 exact sourceKey를 즉시 소진한다. 실패하거나 process가 종료돼도
    // durable inbox의 FAILED/PENDING row를 scheduler 또는 GitHub 재전송이 재생한다.
    after(async () => {
      try {
        await drainAutomationIngress({ sourceKey: `github:${deliveryId}`, limit: 1 });
      } catch (e) {
        console.error(
          "[webhook] 출시노트 inbox 처리 실패:",
          e instanceof Error ? e.message : e,
        );
      }
    });
  }
  if (delivery.duplicate) {
    return NextResponse.json({ status: "duplicate" });
  }

  try {
    await handleEvent(event, payload, deliveryId);
  } catch {
    if (event === "repository" || event === "push") {
      // durable discovery enqueue 전에 delivery만 완료되는 창을 허용하지 않는다.
      // row를 되돌리고 non-2xx로 응답해 같은 delivery가 다시 claim되게 한다.
      await prisma.webhookDelivery.deleteMany({ where: { deliveryId } });
      console.error(`[webhook] ${event} handler error code=DURABLE_ENQUEUE_FAILED`);
      return NextResponse.json({ error: "temporary webhook processing failure" }, { status: 503 });
    }
    // 기존 mirror upsert는 provider 재동기화 경계가 있으므로 webhook 응답을 유지한다.
    console.error(`[webhook] ${event} handler error code=MIRROR_HANDLER_FAILED`);
  }

  await notifyHooks(event, payload, deliveryId);

  return NextResponse.json({ status: "ok" });
}
