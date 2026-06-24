"use server";

import { revalidatePath } from "next/cache";
import type { AiDraftKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { env } from "@/lib/env";
import { asStringArray } from "@/lib/format";
import {
  miniMaxComplete,
  MiniMaxNotConfiguredError,
} from "@/lib/ai/minimax";
import {
  AGENTS,
  buildPlanningPrompt,
  buildDecomposePrompt,
  buildReleaseNotesPrompt,
} from "@/lib/ai/agents";
import { createIssue, addIssueComment } from "@/lib/github/write";
import { getIssue } from "@/lib/github/read";
import { upsertIssue } from "@/lib/sync/mirror";

export interface DraftView {
  id: string;
  kind: AiDraftKind;
  title: string | null;
  issueNumber: number | null;
  outputText: string;
  model: string;
}

function notConfiguredMessage(e: unknown): string {
  if (e instanceof MiniMaxNotConfiguredError) return e.message;
  return e instanceof Error ? e.message : "AI 생성 실패";
}

// ── /plan: 기획 초안 생성. 폼 textarea 를 채우는 용도(즉시 커밋 아님). ──
export async function generatePlanningDraft(input: {
  repoFullName: string;
  title: string;
  idea: string;
}): Promise<{ text: string }> {
  const session = await requireSession();
  const login = session.user.login ?? "unknown";
  if (!env.minimaxConfigured()) throw new MiniMaxNotConfiguredError();

  const app = await prisma.app.findUnique({
    where: { repoFullName: input.repoFullName },
  });
  if (!app) throw new Error("앱을 찾을 수 없습니다.");

  const { system, prompt } = buildPlanningPrompt({
    displayName: app.displayName,
    type: app.type,
    engine: app.engine,
    marketTargets: asStringArray(app.marketTargets),
    title: input.title,
    idea: input.idea,
  });

  let text: string;
  try {
    text = await miniMaxComplete({ system, prompt, temperature: 0.4 });
  } catch (e) {
    throw new Error(notConfiguredMessage(e));
  }

  await prisma.auditLog.create({
    data: {
      actorLogin: login,
      action: "ai.planning_draft",
      entityType: "App",
      entityId: app.id,
      payload: { repo: input.repoFullName, model: env.minimaxModel() },
    },
  });
  return { text };
}

// ── 앱 상세: 단계 에이전트 초안 생성 → AiDraft(DRAFT) 저장. ──
export async function generateStageDraft(input: {
  appId: string;
  kind: AiDraftKind;
  issueNumber?: number;
}): Promise<DraftView> {
  const session = await requireSession();
  const login = session.user.login ?? "unknown";
  if (!env.minimaxConfigured()) throw new MiniMaxNotConfiguredError();

  const app = await prisma.app.findUnique({ where: { id: input.appId } });
  if (!app) throw new Error("앱을 찾을 수 없습니다.");
  const meta = AGENTS[input.kind];

  let system: string;
  let prompt: string;
  let title: string | null = null;
  let issueNumber: number | null = null;
  let inputJson: Prisma.InputJsonObject;

  if (input.kind === "TASK_BREAKDOWN") {
    if (!input.issueNumber) throw new Error("분해할 이슈 번호가 필요합니다.");
    const issue = await getIssue(app.repoFullName, input.issueNumber);
    issueNumber = input.issueNumber;
    ({ system, prompt } = buildDecomposePrompt({
      displayName: app.displayName,
      type: app.type,
      engine: app.engine,
      issueNumber: input.issueNumber,
      issueTitle: issue.title,
      issueBody: issue.body,
    }));
    inputJson = { issueNumber: input.issueNumber, issueTitle: issue.title };
  } else if (input.kind === "RELEASE_NOTES") {
    const mergedPrs = await prisma.pullRequestMirror.findMany({
      where: { appId: app.id, state: "MERGED" },
      orderBy: { mergedAt: "desc" },
      take: 30,
      select: { number: true, title: true },
    });
    const latestRelease = await prisma.releaseRecord.findFirst({
      where: { appId: app.id },
      orderBy: { updatedAt: "desc" },
      select: { version: true },
    });
    const version = latestRelease?.version ?? "vNext";
    title = `릴리스 노트: ${app.displayName} ${version}`;
    ({ system, prompt } = buildReleaseNotesPrompt({
      displayName: app.displayName,
      type: app.type,
      marketTargets: asStringArray(app.marketTargets),
      version,
      mergedPrs,
    }));
    inputJson = { version, prCount: mergedPrs.length };
  } else {
    throw new Error("이 화면에서 지원하지 않는 에이전트입니다.");
  }

  let outputText: string;
  try {
    outputText = await miniMaxComplete({ system, prompt, temperature: 0.3 });
  } catch (e) {
    throw new Error(notConfiguredMessage(e));
  }

  const draft = await prisma.aiDraft.create({
    data: {
      appId: app.id,
      repoFullName: app.repoFullName,
      stage: meta.stage,
      kind: input.kind,
      title,
      issueNumber,
      inputJson,
      outputText,
      model: env.minimaxModel(),
      createdBy: login,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorLogin: login,
      action: "ai.stage_draft",
      entityType: "AiDraft",
      entityId: draft.id,
      payload: { kind: input.kind, repo: app.repoFullName },
    },
  });

  revalidatePath(`/apps/${app.id}`);
  return {
    id: draft.id,
    kind: draft.kind,
    title: draft.title,
    issueNumber: draft.issueNumber,
    outputText: draft.outputText,
    model: draft.model,
  };
}

// ── 초안 커밋: kind 별로 새 이슈 또는 코멘트로 GitHub write → 미러 수렴. ──
export async function commitDraft(input: {
  draftId: string;
  editedText: string;
  editedTitle?: string;
}): Promise<{ ok: boolean; url: string }> {
  const session = await requireSession();
  const login = session.user.login ?? "unknown";

  const draft = await prisma.aiDraft.findUnique({ where: { id: input.draftId } });
  if (!draft) throw new Error("초안을 찾을 수 없습니다.");
  if (draft.status !== "DRAFT") throw new Error("이미 처리된 초안입니다.");

  const meta = AGENTS[draft.kind];
  const body = input.editedText.trim();
  if (!body) throw new Error("본문이 비어 있습니다.");

  let committedIssueNumber: number;
  let url: string;

  if (meta.commitTarget === "ISSUE_COMMENT") {
    if (!draft.issueNumber) throw new Error("코멘트 대상 이슈가 없습니다.");
    await addIssueComment({
      repoFullName: draft.repoFullName,
      issueNumber: draft.issueNumber,
      body: `${body}\n\n_🤖 ${meta.ko}(${draft.model}) 초안 · @${login} 검토/커밋_`,
    });
    committedIssueNumber = draft.issueNumber;
    url = `https://github.com/${draft.repoFullName}/issues/${draft.issueNumber}`;
  } else {
    const title = (input.editedTitle ?? draft.title ?? "").trim();
    if (!title) throw new Error("이슈 제목이 필요합니다.");
    const created = await createIssue({
      repoFullName: draft.repoFullName,
      title,
      body: `${body}\n\n_🤖 ${meta.ko}(${draft.model}) 초안 · @${login} 검토/커밋_`,
      labels: meta.commitLabels,
    });
    await upsertIssue(draft.repoFullName, {
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
    committedIssueNumber = created.number;
    url = created.html_url;
  }

  await prisma.aiDraft.update({
    where: { id: draft.id },
    data: {
      status: "COMMITTED",
      outputText: body,
      title: input.editedTitle ?? draft.title,
      committedIssueNumber,
      committedUrl: url,
      committedAt: new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      actorLogin: login,
      action: "ai.draft_commit",
      entityType: "AiDraft",
      entityId: draft.id,
      payload: { kind: draft.kind, issue: committedIssueNumber },
    },
  });

  revalidatePath(`/apps/${draft.appId}`);
  revalidatePath("/issues");
  return { ok: true, url };
}

// ── 초안 폐기. ──
export async function discardDraft(draftId: string): Promise<{ ok: boolean }> {
  await requireSession();
  const draft = await prisma.aiDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw new Error("초안을 찾을 수 없습니다.");
  if (draft.status === "COMMITTED") throw new Error("이미 커밋된 초안입니다.");
  await prisma.aiDraft.update({
    where: { id: draftId },
    data: { status: "DISCARDED" },
  });
  revalidatePath(`/apps/${draft.appId}`);
  return { ok: true };
}
