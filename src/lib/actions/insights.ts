"use server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAppWriteAccess } from "@/lib/platform/access";
import { evidenceListSchema, readInsight, renderInsight } from "@/lib/insights/contract";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
export async function createInsightDraft(form: FormData) {
  const id = String(form.get("id") ?? "");
  const item = await prisma.insightDocument.findUnique({
    where: { id },
    include: { signal: true },
  });
  if (!item?.signal.appId)
    throw new Error("앱이 연결된 인사이트만 이슈 초안으로 만들 수 있습니다.");
  const app = await prisma.app.findUniqueOrThrow({ where: { id: item.signal.appId } });
  const actor = await requireAppWriteAccess(app.id);
  const facts = evidenceListSchema.parse(item.signal.facts);
  const content = readInsight(item.content, facts);
  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const current = await tx.insightDocument.findUniqueOrThrow({ where: { id } });
          if (current.issueDraftId) return;
          const draft = await tx.aiDraft.create({
            data: {
              appId: app.id,
              repoFullName: app.repoFullName,
              stage: "LIVEOPS",
              kind: "IMPROVEMENT_HYPOTHESIS",
              title: item.signal.title,
              outputText:
                renderInsight(content, facts) +
                "\n\n근거: /feedback/insights/" +
                id +
                "\n\n검토 항목\n- 재현 및 원본 범위 확인\n- 원인 가설 검증\n- 수용 조건과 검증 방법 명시",
              model: item.model ?? "facts",
              inputJson: { insightId: id, inputHash: item.inputHash },
              createdBy: actor.login,
            },
          });
          await tx.insightDocument.update({ where: { id }, data: { issueDraftId: draft.id } });
          await tx.auditLog.create({
            data: {
              actorLogin: actor.login,
              action: "insight.issue_draft",
              entityType: "InsightDocument",
              entityId: id,
              payload: { draftId: draft.id },
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      break;
    } catch (error) {
      if (attempt >= 3 || !["P2034", "P2002"].includes((error as { code?: string }).code ?? ""))
        throw error;
    }
  }
  revalidatePath("/feedback/insights/" + id);
  redirect("/apps/" + app.id + "/development");
}
