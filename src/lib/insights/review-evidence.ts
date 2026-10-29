import { redactCredentialCandidates } from "@/lib/control-plane/contracts";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import type { Evidence } from "./contract";
/** 원문은 보존기한이 있는 리뷰 이벤트에서 실행 시점에만 읽는다. */
export async function resolveReportEvidence(
  kind: string,
  facts: Evidence[],
  db: Pick<Prisma.TransactionClient, "notificationEvent"> = prisma,
): Promise<Evidence[]> {
  if (kind !== "review-themes") return facts;
  const events = await db.notificationEvent.findMany({
    where: {
      id: { in: facts.map((f) => f.value) },
      kind: "STORE_REVIEW",
      createdAt: {
        gte: new Date(Date.now() - env.reviewRetentionDays() * 86400000),
      },
    },
    select: { id: true, payload: true },
  });
  return facts.flatMap((f) => {
    const p = events.find((e) => e.id === f.value)?.payload as
      | Prisma.JsonObject
      | undefined;
    const review = p?.review as Prisma.JsonObject | undefined;
    return typeof review?.body === "string" && review.body.trim()
      ? [{ ...f, value: redactCredentialCandidates(review.body).slice(0, 160) }]
      : [];
  });
}
