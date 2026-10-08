import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { metricDayOf, toDbDay } from "@/lib/analytics/metric-day";
export async function acquireAnalysisPermit(): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const now = new Date();
          const day = toDbDay(metricDayOf(now));
          const configured = Number(process.env.INSIGHTS_DAILY_LIMIT ?? 200);
          const limit = Number.isSafeInteger(configured) && configured >= 0 ? configured : 200;
          await tx.insightApiRequest.updateMany({
            where: { slot: { not: null }, expiresAt: { lte: now } },
            data: { slot: null, completedAt: now },
          });
          if ((await tx.insightApiRequest.count({ where: { day } })) >= limit) return null;
          const busy = await tx.insightApiRequest.findMany({
            where: { slot: { not: null } },
            select: { slot: true },
          });
          const slot = ["minimax-insight:0", "minimax-insight:1"].find(
            (key) => !busy.some((row) => row.slot === key),
          );
          if (!slot) return null;
          const row = await tx.insightApiRequest.create({
            data: { day, slot, expiresAt: new Date(now.getTime() + 4 * 60_000) },
          });
          return row.id;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (attempt >= 3 || !["P2002", "P2034"].includes((error as { code?: string }).code ?? ""))
        throw error;
    }
  }
}
export async function releaseAnalysisPermit(id: string) {
  await prisma.insightApiRequest.update({
    where: { id },
    data: { slot: null, completedAt: new Date() },
  });
}
