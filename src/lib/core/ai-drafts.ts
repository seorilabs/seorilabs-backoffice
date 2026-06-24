import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { asStringArray } from "@/lib/format";
import { miniMaxComplete } from "@/lib/ai/minimax";
import { AGENTS, buildPlanningPrompt } from "@/lib/ai/agents";
import { createIssue, addIssueComment } from "@/lib/github/write";
import { upsertIssue } from "@/lib/sync/mirror";

// 세션 비의존 코어(텔레그램·웹 공용). actorLabel 로 행위자 추적.

export interface PlanningDraftResult {
  id: string;
  title: string;
  outputText: string;
  repoFullName: string;
  displayName: string;
}

// 기획 초안 생성 → AiDraft(PLANNING_SPEC, DRAFT) 저장.
export async function createPlanningDraftCore(input: {
  appId: string;
  idea: string;
  title?: string;
  actorLabel?: string;
}): Promise<PlanningDraftResult> {
  if (!env.minimaxConfigured()) throw new Error("MiniMax 비활성");
  const app = await prisma.app.findUnique({ where: { id: input.appId } });
  if (!app) throw new Error("앱을 찾을 수 없습니다.");

  const title = (input.title ?? input.idea).trim().slice(0, 120) || "무제 기획";
  const { system, prompt } = buildPlanningPrompt({
    displayName: app.displayName,
    type: app.type,
    engine: app.engine,
    marketTargets: asStringArray(app.marketTargets),
    title,
    idea: input.idea,
  });
  const outputText = await miniMaxComplete({ system, prompt, temperature: 0.4 });

  const draft = await prisma.aiDraft.create({
    data: {
      appId: app.id,
      repoFullName: app.repoFullName,
      stage: "PLANNING",
      kind: "PLANNING_SPEC",
      title,
      inputJson: { idea: input.idea },
      outputText,
      model: env.minimaxModel(),
      createdBy: input.actorLabel ?? null,
    },
  });

  return {
    id: draft.id,
    title,
    outputText,
    repoFullName: app.repoFullName,
    displayName: app.displayName,
  };
}

export interface CommitDraftResult {
  issueNumber: number;
  url: string;
  repoFullName: string;
  appId: string;
}

// 초안 커밋: kind 별 새 이슈 또는 코멘트 → 미러 수렴. DRAFT 일 때만 동작(멱등).
export async function commitDraftCore(input: {
  draftId: string;
  actorLabel: string;
  editedText?: string;
  editedTitle?: string;
}): Promise<CommitDraftResult> {
  const draft = await prisma.aiDraft.findUnique({ where: { id: input.draftId } });
  if (!draft) throw new Error("초안을 찾을 수 없습니다.");
  if (draft.status !== "DRAFT") throw new Error("이미 처리된 초안입니다.");

  const meta = AGENTS[draft.kind];
  const body = (input.editedText ?? draft.outputText).trim();
  if (!body) throw new Error("본문이 비어 있습니다.");
  const footer = `\n\n_🤖 ${meta.ko}(${draft.model}) · ${input.actorLabel}_`;

  let committedIssueNumber: number;
  let url: string;

  if (meta.commitTarget === "ISSUE_COMMENT") {
    if (!draft.issueNumber) throw new Error("코멘트 대상 이슈가 없습니다.");
    await addIssueComment({
      repoFullName: draft.repoFullName,
      issueNumber: draft.issueNumber,
      body: body + footer,
    });
    committedIssueNumber = draft.issueNumber;
    url = `https://github.com/${draft.repoFullName}/issues/${draft.issueNumber}`;
  } else {
    const title = (input.editedTitle ?? draft.title ?? "").trim();
    if (!title) throw new Error("이슈 제목이 필요합니다.");
    const created = await createIssue({
      repoFullName: draft.repoFullName,
      title,
      body: body + footer,
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

  return { issueNumber: committedIssueNumber, url, repoFullName: draft.repoFullName, appId: draft.appId };
}
