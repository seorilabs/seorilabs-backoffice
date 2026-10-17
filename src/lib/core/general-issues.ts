import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { claudeComplete } from "@/lib/ai/claude";
import { AI_DRAFT_MAX_TOKENS } from "@/lib/ai/agents";
import { generalIssuePrompt, parseGeneralIssueOutput, validateGeneralIssueRequest, validateGeneralIssueText } from "./general-issue-contract";
import { requireGeneralIssueAccess, requireGeneralIssuesEnabled, type GeneralIssueActor } from "./general-issue-access";

export async function createGeneralIssueDraftCore(input: GeneralIssueActor & { appId: string; request: string }) {
  requireGeneralIssuesEnabled();
  const request = validateGeneralIssueRequest(input.request);
  const access = await requireGeneralIssueAccess(input.appId, input);
  const output = parseGeneralIssueOutput(await claudeComplete({
    ...generalIssuePrompt(access.app.displayName, access.app.repoFullName, request),
    jsonOutput: true, maxTokens: AI_DRAFT_MAX_TOKENS, usage: { path: "general-issue" },
  }));
  const current = await requireGeneralIssueAccess(input.appId, { ...input, expectedGithubId: access.githubId });
  requireGeneralIssuesEnabled();
  if (current.app.repoFullName !== access.app.repoFullName) throw new Error("대상 저장소가 변경되었습니다. 앱을 다시 선택하세요.");
  const draft = await prisma.aiDraft.create({ data: {
    appId: input.appId, repoFullName: access.app.repoFullName, stage: "DEVELOPMENT", kind: "GENERAL_ISSUE",
    title: output.title, outputText: output.body, inputJson: { request, githubId: access.githubId },
    model: env.claudeChatModel(), createdBy: input.actorLabel,
  } });
  await generalIssueAudit(input.actorLabel, "ai.general_issue_created", draft.id);
  return draft;
}

export async function generalIssueAudit(actorLabel: string, action: string, draftId: string) {
  await prisma.auditLog.create({ data: { actorLogin: actorLabel, action, entityType: "AiDraft", entityId: draftId } });
}

export async function requireOwnedGeneralIssue(draftId: string, actor: GeneralIssueActor) {
  const draft = await prisma.aiDraft.findUnique({ where: { id: draftId } });
  if (!draft || draft.kind !== "GENERAL_ISSUE" || draft.createdBy !== actor.actorLabel) throw new Error("본인이 만든 일반 초안만 처리할 수 있습니다.");
  const input = draft.inputJson as { githubId?: string };
  if (!input.githubId) throw new Error("초안 작성 계정을 확인할 수 없습니다.");
  const access = await requireGeneralIssueAccess(draft.appId, { ...actor, expectedGithubId: input.githubId });
  if (access.app.repoFullName !== draft.repoFullName) throw new Error("초안의 대상 저장소가 현재 앱과 다릅니다.");
  return draft;
}

export async function editGeneralIssueDraftCore(input: GeneralIssueActor & { draftId: string; title: string; body: string; version: string }) {
  requireGeneralIssuesEnabled();
  const text = validateGeneralIssueText(input.title, input.body);
  const draft = await requireOwnedGeneralIssue(input.draftId, input);
  const changed = await prisma.aiDraft.updateMany({
    where: { id: draft.id, status: "DRAFT", claimedAt: null, updatedAt: new Date(input.version) },
    data: { title: text.title, outputText: text.body },
  });
  if (changed.count !== 1) throw new Error("초안이 변경되었거나 등록 중입니다. 다시 불러와 확인하세요.");
  await generalIssueAudit(input.actorLabel, "ai.general_issue_edited", draft.id);
  return prisma.aiDraft.findUniqueOrThrow({ where: { id: draft.id } });
}

export async function discardGeneralIssueDraftCore(draftId: string, actor: GeneralIssueActor) {
  const draft = await requireOwnedGeneralIssue(draftId, actor);
  const changed = await prisma.aiDraft.updateMany({ where: { id: draft.id, status: "DRAFT", claimedAt: null }, data: { status: "DISCARDED" } });
  if (changed.count !== 1 && draft.status !== "DISCARDED") throw new Error("등록 중이거나 처리된 초안입니다. 등록 결과를 확인하세요.");
  await generalIssueAudit(actor.actorLabel, "ai.general_issue_discarded", draft.id);
}
