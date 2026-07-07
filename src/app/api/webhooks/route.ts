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
import { normalizeLabels, priorityFromLabels } from "@/lib/domain/labels";
import { generateReleaseNoteCore } from "@/lib/core/release-notes";
import { isDisabledAppStatus } from "@/lib/domain/app-visibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WebhookPayload {
  action?: string;
  ref?: string;
  created?: boolean;
  deleted?: boolean;
  after?: string;
  repository?: { full_name?: string };
  issue?: GhIssueInput;
  pull_request?: GhPrInput;
  workflow_run?: GhRunInput;
  label?: { name?: string };
}

// 실시간 webhook 에서만(미러 backfill 아님) 텔레그램 알림. 실패해도 webhook 200 유지.
async function shouldNotifyRepo(repoFullName: string): Promise<boolean> {
  const app = await prisma.app.findUnique({
    where: { repoFullName },
    select: { status: true },
  });
  return !app || !isDisabledAppStatus(app.status);
}

async function notifyHooks(event: string, p: WebhookPayload): Promise<void> {
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
        await notify(
          `${gate === "release" ? "🚀" : "📝"} <b>승인 필요</b> ${esc(repo)} #${p.issue.number}\n${esc(p.issue.title)}`,
          [[{ text: `승인 (${gate})`, callback_data: `approve:${gate}:${mir.id}` }]],
        );
      }
    }
    // 마켓 배포(AIT/Play/App Store)만 대상 — GitHub Pages 프리뷰(Deploy Godot Web Pages)는
    // 빌드 미리보기일 뿐 마켓 배포가 아니므로 제외한다(main 병합마다 오탐 넛지 방지).
    const wfName = p.workflow_run?.name ?? "";
    const isDeploy =
      /deploy|google|app\s*store|appstore|ait|toss/i.test(wfName) &&
      !/pages/i.test(wfName);
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
    // 출시노트는 태그 생성 시점에만 만든다(태그 push webhook + 백오피스/텔레그램 태그 생성).
    // 배포 성공 후 별도 릴리스 노트 넛지는 하지 않는다.
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
    case "push": {
      // 릴리즈 태그 생성 → 출시노트 자동 생성(fire-and-forget, 200 안 막음).
      const ref = p.ref ?? "";
      if (ref.startsWith("refs/tags/") && p.created && !p.deleted) {
        const version = ref.slice("refs/tags/".length);
        if (/^v?\d+\./.test(version)) {
          void generateReleaseNoteCore({
            repoFullName: repo,
            version,
            headSha: p.after,
          }).catch((e) =>
            console.error("[webhook] 출시노트 생성 실패:", e instanceof Error ? e.message : e),
          );
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
    await handleEvent(event, payload);
  } catch (err) {
    // 핸들러 실패해도 200 (GitHub 재전송 + reconcile 로 복구). 로깅만.
    console.error(`[webhook] ${event} handler error:`, err);
  }

  await notifyHooks(event, payload);

  return NextResponse.json({ status: "ok" });
}
