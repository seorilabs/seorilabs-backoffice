"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
import { createGeneralIssueDraftCore, editGeneralIssueDraftCore, discardGeneralIssueDraftCore, requireOwnedGeneralIssue } from "@/lib/core/general-issues";
import { commitDraftCore, confirmDraftRegistrationCore } from "@/lib/core/ai-drafts";

async function actor() {
  const session = await requireSession();
  if (!session.user.login) throw new Error("로그인이 필요합니다.");
  return { actorLabel: `@${session.user.login}` };
}
function view(draft: Awaited<ReturnType<typeof createGeneralIssueDraftCore>>) {
  return { id: draft.id, appId: draft.appId, repoFullName: draft.repoFullName, title: draft.title ?? "", body: draft.outputText, version: draft.updatedAt.toISOString(), pending: !!draft.claimedAt, status: draft.status, url: draft.committedUrl };
}

async function respond<T>(task: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try { return { ok: true, value: await task() }; }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    const expected = /^(요청은|제목은|본문은|초안|일반 이슈|본인이|현재 GitHub|GitHub 계정|기획 또는|해당 앱|플랫폼 관리|앱을 찾을|대상 저장소|등록 진행|등록 중|이미 처리|로그인|Claude)/.test(message);
    return { ok: false, error: expected ? message : "처리에 실패했습니다. 입력은 유지됩니다. 등록 요청을 보냈다면 결과 확인을 눌러 주세요." };
  }
}

export async function createGeneralIssueDraft(input: { appId: string; request: string }) {
  return respond(async () => view(await createGeneralIssueDraftCore({ ...input, ...await actor() })));
}
export async function loadGeneralIssueDraft(draftId: string) {
  return view(await requireOwnedGeneralIssue(draftId, await actor()));
}
export async function editGeneralIssueDraft(input: { draftId: string; title: string; body: string; version: string }) {
  return respond(async () => view(await editGeneralIssueDraftCore({ ...input, ...await actor() })));
}
export async function registerGeneralIssue(draftId: string) {
  return respond(async () => {
  const currentActor = await actor();
  await requireOwnedGeneralIssue(draftId, currentActor);
  const result = await commitDraftCore({ draftId, ...currentActor });
  revalidatePath("/work/issues");
  revalidatePath(`/apps/${result.appId}/development`);
  return result;
  });
}
export async function confirmGeneralIssue(draftId: string) {
  return respond(async () => {
  const currentActor = await actor();
  await requireOwnedGeneralIssue(draftId, currentActor);
  const result = await confirmDraftRegistrationCore(draftId, currentActor.actorLabel);
  revalidatePath("/work/issues");
  return result;
  });
}
export async function discardGeneralIssueDraft(draftId: string) {
  return respond(async () => { await discardGeneralIssueDraftCore(draftId, await actor()); });
}
