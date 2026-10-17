"use client";

import { generalIssueErrorMessage } from "@/lib/core/general-issue-contract";
import { useState, useTransition } from "react";
import Link from "next/link";
import { createGeneralIssueDraft, editGeneralIssueDraft, registerGeneralIssue, confirmGeneralIssue, discardGeneralIssueDraft, loadGeneralIssueDraft } from "@/lib/actions/general-issues";

type Draft = Awaited<ReturnType<typeof loadGeneralIssueDraft>>;
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
export function GeneralIssueForm({ apps, selectedAppId, initialDraft = null, enabled = true }: { apps: { id: string; displayName: string; repoFullName: string }[]; selectedAppId: string; initialDraft?: Draft | null; enabled?: boolean }) {
  const [appId, setAppId] = useState(selectedAppId);
  const [request, setRequest] = useState("");
  const [draft, setDraft] = useState<Draft | null>(initialDraft);
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [body, setBody] = useState(initialDraft?.body ?? "");
  const [error, setError] = useState("");
  const [url, setUrl] = useState(initialDraft?.url ?? "");
  const [pending, startTransition] = useTransition();
  const app = apps.find(a => a.id === (draft?.appId ?? appId));
  const inputClass = "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base focus:outline-2 focus:outline-blue-600 disabled:bg-neutral-100";
  const buttonClass = "min-h-11 rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50";
  function perform(task: () => Promise<void>) {
    setError("");
    startTransition(async () => { try { await task(); } catch (e) { setError(generalIssueErrorMessage(e)); } });
  }
  function showDraft(value: Draft) { setDraft(value); setTitle(value.title); setBody(value.body); }
  return <div className="max-w-3xl space-y-5">
    <ol aria-label="등록 단계" className="flex flex-wrap gap-3 text-sm text-neutral-600">
      {["앱·요청 입력", "제목·본문 검토", "등록 결과"].map((step, i) => <li key={step} aria-current={(url ? 2 : draft ? 1 : 0) === i ? "step" : undefined} className={(url ? 2 : draft ? 1 : 0) === i ? "font-semibold text-neutral-950" : ""}>{i + 1}. {step}</li>)}
    </ol>
    {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {url ? <div role="status" className="space-y-3 rounded-lg border border-green-200 bg-green-50 p-5">
      <h2 className="font-semibold">이슈를 등록했습니다</h2>
      <p className="break-all text-sm">{app?.displayName} · {draft?.repoFullName}</p>
      <a className="block break-all text-blue-700 underline" href={url} target="_blank" rel="noreferrer">GitHub 이슈 #{url.split("/").pop()} 확인</a>
      <Link className="inline-block underline" href="/work/issues">이슈 목록</Link>
    </div> : draft ? <form className="space-y-4" onSubmit={e => { e.preventDefault(); perform(async () => {
      const saved = unwrap(await editGeneralIssueDraft({ draftId: draft.id, title, body, version: draft.version }));
      showDraft(saved);
      // 요청 전부터 결과 불명확 상태로 둬 통신 실패 후에도 재등록을 막는다.
      setDraft({ ...saved, pending: true });
      const result = unwrap(await registerGeneralIssue(saved.id));
      setUrl(result.url);
    }); }}>
      <div className="rounded-lg border bg-neutral-50 p-3"><strong>{app?.displayName}</strong><p className="break-all text-sm text-neutral-600">{draft.repoFullName}</p></div>
      <label className="block space-y-1"><span className="text-sm font-medium">이슈 제목</span><input required maxLength={120} value={title} disabled={pending || draft.pending || !enabled} onChange={e => setTitle(e.target.value)} className={inputClass} /><span className="text-xs text-neutral-500">{title.length}/120자</span></label>
      <label className="block space-y-1"><span className="text-sm font-medium">이슈 본문 · Markdown</span><textarea required maxLength={4000} rows={12} value={body} disabled={pending || draft.pending || !enabled} onChange={e => setBody(e.target.value)} className={inputClass} /><span className="text-xs text-neutral-500">{body.length}/4,000자</span></label>
      {draft.pending ? <div className="space-y-2"><p className="text-sm">등록 진행 중이거나 결과 확인이 필요합니다.</p><button type="button" className={buttonClass} disabled={pending} onClick={() => perform(async () => { const result = unwrap(await confirmGeneralIssue(draft.id)); if (result.confirmed && result.url) setUrl(result.url); else { showDraft(await loadGeneralIssueDraft(draft.id)); setError(result.pending ? "아직 등록 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요." : "등록 요청이 거절되었습니다. 내용을 확인한 뒤 다시 등록할 수 있습니다."); } })}>등록 결과 확인</button></div> : <div className="flex flex-wrap gap-3">
        <button className={buttonClass} disabled={pending || !enabled} type="submit">{pending ? "처리 중…" : "이슈 등록"}</button>
        <button className="min-h-11 rounded-md border px-4 py-2 text-sm" disabled={pending} type="button" onClick={() => perform(async () => { unwrap(await discardGeneralIssueDraft(draft.id)); setDraft(null); window.history.replaceState(null, "", "/work/issues/new"); })}>취소</button>
      </div>}
    </form> : !enabled ? <p role="status">일반 이슈 등록은 현재 비활성 상태입니다. <Link href="/work/issues" className="underline">이슈 목록</Link></p> : <form className="space-y-4" onSubmit={e => { e.preventDefault(); perform(async () => {
      const created = unwrap(await createGeneralIssueDraft({ appId, request }));
      showDraft(created);
      window.history.replaceState(null, "", `/work/issues/new?draft=${encodeURIComponent(created.id)}`);
    }); }}>
      <label className="block space-y-1"><span className="text-sm font-medium">대상 앱</span><select required className={inputClass} disabled={pending} value={appId} onChange={e => setAppId(e.target.value)}><option value="">앱 선택</option>{apps.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}</select></label>
      {app && <p className="break-all text-sm text-neutral-600">저장소: {app.repoFullName}</p>}
      <label className="block space-y-1"><span className="text-sm font-medium">등록할 요청</span><textarea required maxLength={4000} rows={7} value={request} disabled={pending} onChange={e => setRequest(e.target.value)} placeholder="예: 설정 화면에서 알림을 끄는 방법을 조사해 주세요." className={inputClass} /><span className="text-xs text-neutral-500">{request.length}/4,000자</span></label>
      <button className={buttonClass} disabled={pending || !appId || !request.trim()} type="submit">{pending ? "초안 정리 중…" : "Claude로 초안 정리"}</button>
    </form>}
    {pending && <p role="status" className="text-sm text-neutral-600">처리 중입니다. 잠시 기다려 주세요.</p>}
  </div>;
}
