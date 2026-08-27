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
import { generateAndPublishReleaseNotes } from "@/lib/core/release-ops";
import { parseStableSemVerTag } from "@/lib/core/stable-semver";
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
      if (p.pull_request) await upsertPr(repo, p.pull_request);
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

      // 릴리즈 태그 생성 → 응답 이후 출시노트 생성·발행(태그/webhook 응답을 막지 않음).
      const ref = p.ref ?? "";
      if (ref.startsWith("refs/tags/") && p.created && !p.deleted) {
        const version = ref.slice("refs/tags/".length);
        // snapshot 후보 태그(vX.Y.Z-snapshot.N)는 빌드 출처일 뿐 정식 Release가 아니다.
        if (parseStableSemVerTag(version)) {
          after(async () => {
            try {
              await generateAndPublishReleaseNotes({
                repoFullName: repo,
                version,
                headSha: p.after,
              });
            } catch (e) {
              console.error(
                "[webhook] 출시노트 생성 실패:",
                e instanceof Error ? e.message : e,
              );
            }
          });
        }
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

  // delivery 단위 멱등 가드: 이미 처리한 delivery 면 즉시 200.
  try {
    await prisma.webhookDelivery.create({
      data: { deliveryId, event, action: payload.action ?? null },
    });
  } catch {
    return NextResponse.json({ status: "duplicate" });
  }

  try {
    await handleEvent(event, payload, deliveryId);
  } catch (err) {
    // 핸들러 실패해도 200 (GitHub 재전송 + reconcile 로 복구). 로깅만.
    console.error(`[webhook] ${event} handler error:`, err);
  }

  await notifyHooks(event, payload, deliveryId);

  return NextResponse.json({ status: "ok" });
}
