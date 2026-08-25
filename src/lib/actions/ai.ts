"use server";

import { revalidatePath } from "next/cache";
import type { AiDraftKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { env } from "@/lib/env";
import { asStringArray } from "@/lib/format";
import { geminiComplete, GeminiNotConfiguredError } from "@/lib/ai/gemini";
import { buildPlanningPrompt } from "@/lib/ai/agents";
import { getRepoContext } from "@/lib/github/read";
import {
  commitDraftCore,
  generateStageDraftCore,
} from "@/lib/core/ai-drafts";
import { HIDDEN_APP_ERROR, isDisabledAppStatus, visibleAppWhere } from "@/lib/domain/app-visibility";

export interface DraftView {
  id: string;
  kind: AiDraftKind;
  title: string | null;
  issueNumber: number | null;
  outputText: string;
  model: string;
}

function notConfiguredMessage(e: unknown): string {
  if (e instanceof GeminiNotConfiguredError) return e.message;
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
  if (!env.geminiChatConfigured()) throw new GeminiNotConfiguredError();

  const app = await prisma.app.findFirst({
    where: { repoFullName: input.repoFullName, ...visibleAppWhere },
  });
  if (!app) throw new Error(HIDDEN_APP_ERROR);

  const codebaseContext = await getRepoContext(app.repoFullName).catch(() => "");
  const { system, prompt } = buildPlanningPrompt({
    displayName: app.displayName,
    type: app.type,
    engine: app.engine,
    marketTargets: asStringArray(app.marketTargets),
    title: input.title,
    idea: input.idea,
    codebaseContext: codebaseContext || undefined,
  });

  let text: string;
  try {
    text = await geminiComplete({ system, prompt, usage: { path: "action" } });
  } catch (e) {
    throw new Error(notConfiguredMessage(e));
  }

  await prisma.auditLog.create({
    data: {
      actorLogin: login,
      action: "ai.planning_draft",
      entityType: "App",
      entityId: app.id,
      payload: { repo: input.repoFullName, model: env.geminiChatModel() },
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

  let draft;
  try {
    draft = await generateStageDraftCore({
      appId: input.appId,
      kind: input.kind,
      issueNumber: input.issueNumber,
      actorLabel: login,
    });
  } catch (e) {
    throw new Error(notConfiguredMessage(e));
  }

  await prisma.auditLog.create({
    data: {
      actorLogin: login,
      action: "ai.stage_draft",
      entityType: "AiDraft",
      entityId: draft.id,
      payload: { kind: input.kind, appId: input.appId },
    },
  });

  revalidatePath(`/apps/${draft.appId}`);
  revalidatePath(`/apps/${draft.appId}/development`);
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

  const r = await commitDraftCore({
    draftId: input.draftId,
    actorLabel: `@${login}`,
    editedText: input.editedText,
    editedTitle: input.editedTitle,
  });

  await prisma.auditLog.create({
    data: {
      actorLogin: login,
      action: "ai.draft_commit",
      entityType: "AiDraft",
      entityId: input.draftId,
      payload: { issue: r.issueNumber },
    },
  });

  revalidatePath(`/apps/${r.appId}`);
  revalidatePath(`/apps/${r.appId}/development`);
  revalidatePath("/issues");
  return { ok: true, url: r.url };
}

// ── 초안 폐기. ──
export async function discardDraft(draftId: string): Promise<{ ok: boolean }> {
  await requireSession();
  const draft = await prisma.aiDraft.findUnique({
    where: { id: draftId },
    include: { app: { select: { status: true } } },
  });
  if (!draft) throw new Error("초안을 찾을 수 없습니다.");
  if (isDisabledAppStatus(draft.app.status)) throw new Error(HIDDEN_APP_ERROR);
  if (draft.status === "COMMITTED") throw new Error("이미 커밋된 초안입니다.");
  await prisma.aiDraft.update({
    where: { id: draftId },
    data: { status: "DISCARDED" },
  });
  revalidatePath(`/apps/${draft.appId}`);
  revalidatePath(`/apps/${draft.appId}/development`);
  return { ok: true };
}
