import Link from "next/link";
import { loadGeneralIssueDraft } from "@/lib/actions/general-issues";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { requireSession } from "@/lib/auth-helpers";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { GeneralIssueForm } from "@/components/GeneralIssueForm";

export const dynamic = "force-dynamic";
export default async function NewIssuePage({ searchParams }: { searchParams: Promise<{ app?: string; draft?: string }> }) {
  const session = await requireSession();
  const enabled = env.featureGeneralIssues();
  const user = await prisma.user.findUnique({ where: { login: session.user.login ?? "" } });
  const apps = user?.allowlisted && ["ADMIN", "MAINTAINER"].includes(user.role) ? await prisma.app.findMany({
    where: { ...visibleAppWhere, ...(user.role === "ADMIN" ? {} : { owners: { some: { userId: user.id, role: "OWNER" } } }) },
    select: { id: true, displayName: true, repoFullName: true }, orderBy: { displayName: "asc" },
  }) : [];
  const params = await searchParams;
  const selected = params.app;
  let initialDraft: Awaited<ReturnType<typeof loadGeneralIssueDraft>> | null = null;
  let draftError = false;
  if (params.draft) {
    try { initialDraft = await loadGeneralIssueDraft(params.draft); }
    catch { draftError = true; }
  }
  const drafts = await prisma.aiDraft.findMany({ where: { kind: "GENERAL_ISSUE", status: "DRAFT", createdBy: `@${session.user.login}`, appId: { in: apps.map(a => a.id) } }, orderBy: { createdAt: "desc" }, take: 20 });
  return <div className="space-y-5 px-4 py-6 sm:p-8"><div><h1 className="text-xl font-semibold">일반 이슈 등록</h1><p className="mt-1 text-sm text-neutral-600">요청을 정리하고 내용을 확인한 뒤 GitHub에 등록합니다.</p></div>
    {!enabled && <p role="status">일반 이슈 등록은 현재 비활성 상태입니다. 기존 초안의 등록 결과는 확인할 수 있습니다.</p>}
    {draftError && <div role="alert" className="space-y-2 rounded border p-3"><p>초안을 불러올 수 없습니다. 작성자 계정과 앱 쓰기 권한을 확인하세요.</p><Link className="mr-4 underline" href="/work/issues/new">새 이슈 작성</Link><Link className="underline" href="/work/issues">이슈 목록</Link></div>}
    {!draftError && apps.length && (enabled || initialDraft) ? <GeneralIssueForm apps={apps} selectedAppId={apps.some(a => a.id === selected) ? selected! : ""} initialDraft={initialDraft} enabled={enabled} /> : !draftError && apps.length === 0 ? <p>이슈를 작성할 수 있는 앱이 없습니다. 앱 쓰기 권한을 확인하세요.</p> : null}
    {!initialDraft && drafts.length > 0 && <div className="space-y-2"><h2 className="font-medium">작성 중인 초안</h2>{drafts.map(d => <Link key={d.id} href={`/work/issues/new?draft=${d.id}`} className="block break-words text-sm text-blue-700 underline">{d.title} · {d.repoFullName}{d.claimedAt ? " · 등록 결과 확인 필요" : ""}</Link>)}</div>}
  </div>;
}
