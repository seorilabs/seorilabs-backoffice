import type { MessageActionRow } from "@/lib/notifications/channel";

export function generalIssueCard(draft: { id: string; title: string | null; outputText: string; repoFullName: string; claimedAt: Date | null; status: string; committedUrl: string | null }, displayName: string) {
  if (draft.status === "COMMITTED") return { text: `✅ ${displayName} · ${draft.repoFullName}\n이슈 등록 완료: ${draft.committedUrl}`, components: [] };
  if (draft.status === "DISCARDED") return { text: "✖️ 초안을 취소했습니다.", components: [] };
  const components: MessageActionRow[] = [{ type: 1, components: draft.claimedAt
    ? [{ type: 2, style: 2, label: "등록 결과 확인", custom_id: `draft:readback:${draft.id}` }]
    : [{ type: 2, style: 2, label: "수정", custom_id: `draft:edit:${draft.id}` }, { type: 2, style: 3, label: "이슈 등록", custom_id: `draft:commit:${draft.id}` }, { type: 2, style: 2, label: "취소", custom_id: `draft:cancel:${draft.id}` }] }];
  return { text: `📝 **${draft.title}**\n${displayName} · ${draft.repoFullName}\n\n${draft.outputText}${draft.claimedAt ? "\n\n등록 진행 중이거나 결과 확인이 필요합니다." : ""}`, components };
}

export function generalIssueEditModal(draft: { id: string; title: string | null; outputText: string; updatedAt: Date }) {
  return { type: 9, data: { custom_id: `gedit:${draft.id}:${draft.updatedAt.getTime()}`, title: "일반 이슈 수정", components: [
    { type: 1, components: [{ type: 4, custom_id: "title", label: "이슈 제목", style: 1, required: true, max_length: 120, value: draft.title ?? "" }] },
    { type: 1, components: [{ type: 4, custom_id: "body", label: "이슈 본문 · Markdown", style: 2, required: true, max_length: 4000, value: draft.outputText }] },
  ] } };
}
