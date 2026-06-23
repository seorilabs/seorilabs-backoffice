"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { createIssue } from "@/lib/github/write";
import { upsertIssue } from "@/lib/sync/mirror";
import { toggleApprovalCore } from "@/lib/core/approvals";

export interface PlanningIntake {
  repoFullName: string;
  title: string;
  summary: string;
  market?: string;
  priority?: string;
  owner?: string;
  agent?: string;
  intakeState?: string;
  target?: string;
  verification?: string;
  labels: string[];
}

// seorilabs_execution_task.yml 필드 1:1 매칭 본문 + 멱등 마커.
function renderBody(input: PlanningIntake, clientReqId: string): string {
  const rows = [
    ["App/Repo", input.repoFullName],
    ["Market", input.market],
    ["Priority", input.priority],
    ["Owner", input.owner],
    ["Agent", input.agent],
    ["Intake State", input.intakeState],
    ["Target", input.target],
    ["Verification", input.verification],
  ].filter(([, v]) => v);

  const meta = rows.map(([k, v]) => `- **${k}**: ${v}`).join("\n");
  return [
    input.summary.trim(),
    "",
    "---",
    meta,
    "",
    `<!-- bo:req=${clientReqId} -->`,
    "_백오피스 기획 인테이크에서 생성됨._",
  ].join("\n");
}

// 기획 입력 폼 → GitHub 이슈 생성 → 즉시 미러(webhook 으로 재수렴).
export async function createPlanningIssue(
  input: PlanningIntake,
): Promise<{ number: number; htmlUrl: string }> {
  const session = await requireSession();
  const login = session.user.login ?? "unknown";
  const clientReqId = randomUUID();
  const body = renderBody(input, clientReqId);

  const created = await createIssue({
    repoFullName: input.repoFullName,
    title: input.title,
    body,
    labels: input.labels,
  });

  await upsertIssue(input.repoFullName, {
    number: created.number,
    node_id: created.node_id,
    title: created.title,
    state: created.state,
    state_reason: created.state_reason ?? null,
    body: created.body ?? null,
    user: created.user ? { login: created.user.login } : null,
    assignees: (created.assignees ?? []).map((a) => ({ login: a.login })),
    labels: created.labels,
    milestone: created.milestone ? { title: created.milestone.title } : null,
    created_at: created.created_at,
    updated_at: created.updated_at,
  });

  await prisma.auditLog.create({
    data: {
      actorLogin: login,
      action: "issue.create",
      entityType: "IssueMirror",
      entityId: created.node_id,
      payload: { repo: input.repoFullName, number: created.number },
    },
  });

  revalidatePath("/issues");
  revalidatePath("/plan");
  return { number: created.number, htmlUrl: created.html_url };
}

// 승인 게이트 토글 (approval:planning | approval:release).
export async function toggleApproval(input: {
  issueId: string;
  gate: "planning" | "release";
  on: boolean;
  reason?: string;
}): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const login = session.user.login ?? "unknown";
  await toggleApprovalCore({ ...input, actorLabel: `@${login}` });
  revalidatePath("/approvals");
  revalidatePath("/issues");
  return { ok: true };
}
