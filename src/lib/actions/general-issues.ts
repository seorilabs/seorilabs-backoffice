"use server";

import { generalIssueErrorMessage } from "@/lib/core/general-issue-contract";
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
    return { ok: false, error: generalIssueErrorMessage(error) };
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
