import { NextRequest, NextResponse } from "next/server";
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
import { notify, esc } from "@/lib/telegram/client";
import { env } from "@/lib/env";
import { normalizeLabels, priorityFromLabels } from "@/lib/domain/labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WebhookPayload {
  action?: string;
  ref?: string;
  repository?: { full_name?: string };
  issue?: GhIssueInput;
  pull_request?: GhPrInput;
  workflow_run?: GhRunInput;
  label?: { name?: string };
}

// 실시간 webhook 에서만(미러 backfill 아님) 텔레그램 알림. 실패해도 webhook 200 유지.
async function notifyHooks(event: string, p: WebhookPayload): Promise<void> {
  try {
    const repo = (p.repository?.full_name ?? "").replace("seorilabs/", "");
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
        await notify(
          `${gate === "release" ? "🚀" : "📝"} <b>승인 필요</b> ${esc(repo)} #${p.issue.number}\n${esc(p.issue.title)}`,
          [[{ text: `승인 (${gate})`, callback_data: `approve:${gate}:${mir.id}` }]],
        );
      }
    }
    const isDeploy = /deploy|google|app\s*store|appstore|ait|toss/i.test(
      p.workflow_run?.name ?? "",
    );
    if (
      event === "workflow_run" &&
      p.workflow_run?.status === "completed" &&
      p.workflow_run.conclusion === "failure" &&
      isDeploy
    ) {
      await notify(
        `❌ <b>배포 실패</b> ${esc(repo)}\n${esc(p.workflow_run.name ?? "")} (${esc(p.workflow_run.head_branch ?? "")})`,
      );
    }
    // 배포 성공 → 릴리스 노트 넛지(출시/운영 단계에서만, 노이즈 억제).
    if (
      event === "workflow_run" &&
      p.workflow_run?.status === "completed" &&
      p.workflow_run.conclusion === "success" &&
      isDeploy &&
      env.minimaxConfigured() &&
      p.repository?.full_name
    ) {
      const app = await prisma.app.findFirst({
        where: { repoFullName: p.repository.full_name },
        select: { id: true, displayName: true, currentStage: true },
      });
      if (app && (app.currentStage === "RELEASE" || app.currentStage === "LIVEOPS")) {
        await notify(
          `🚀 <b>${esc(app.displayName)}</b> 배포 성공 — 릴리스 노트 만들까요?`,
          [[{ text: "🚀 릴리스 노트 생성", callback_data: `gen:RELEASE_NOTES:${app.id}` }]],
        );
      }
    }
    // 새 P1 이슈 → 즉시 알림.
    if (event === "issues" && p.action === "opened" && p.issue) {
      const labels = normalizeLabels(p.issue.labels as unknown as Array<string | { name?: string }>);
      if (priorityFromLabels(labels) === "P1") {
        await notify(`🔥 <b>새 P1</b> ${esc(repo)} #${p.issue.number}\n${esc(p.issue.title)}`);
      }
    }
  } catch (e) {
    console.error("[telegram] notifyHooks error:", e);
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
      if (p.pull_request) await upsertPr(repo, p.pull_request);
      break;
    case "workflow_run":
      if (p.workflow_run) await upsertWorkflowRun(repo, p.workflow_run);
      break;
    default:
      // issue_comment, push 등은 v1 에서 미러 대상 아님.
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
    await handleEvent(event, payload);
  } catch (err) {
    // 핸들러 실패해도 200 (GitHub 재전송 + reconcile 로 복구). 로깅만.
    console.error(`[webhook] ${event} handler error:`, err);
  }

  await notifyHooks(event, payload);

  return NextResponse.json({ status: "ok" });
}
