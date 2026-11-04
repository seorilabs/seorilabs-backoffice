import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validatedEvidence, type Evidence } from "./contract";
import { publishSignal } from "./service";

export const METRIC_COLLECTION_KIND = "metric-collection";
/** 완료 원장에 고정한 근거를 재조회한다. 요청 전후 중단도 같은 실행 ID로 복구한다. */
export async function reconcileMetricCollectionInsights() {
  // JSON 본문은 정렬하지 않는다. 큰 coverage가 MySQL 정렬 메모리를 소진하지 않게 한다.
  const ids = await prisma.sourceCollectionRun.findMany({
    where: { source: { in: ["ga4", "ait-console-run", "ait-console-push"] }, completedAt: { not: null }, coverage: { path: "$.metricInsight.queued", equals: false } },
    orderBy: { startedAt: "asc" }, take: 20, select: { id: true },
  });
  for (const { id } of ids) {
    const run = await prisma.sourceCollectionRun.findUniqueOrThrow({ where: { id } });
    const coverage = run.coverage as Prisma.JsonObject;
    const snapshot = coverage.metricInsight as { source: string; day: string; queued: boolean; facts: Evidence[] };
    await publishSignal({ dedupeKey: `metric-collection:${run.id}`, kind: METRIC_COLLECTION_KIND,
      title: `${snapshot.source === "ga4" ? "GA4" : "앱인토스"} 수집 후 인사이트 · ${snapshot.day}`,
      facts: validatedEvidence(snapshot.facts), observedAt: run.completedAt!,
      sourceRefs: [{ label: "수집 지표와 근거", url: `https://backoffice.vzyx.xyz/analytics?date=${snapshot.day}` }],
    });
    await prisma.sourceCollectionRun.updateMany({ where: { id, coverage: { equals: coverage } },
      data: { coverage: { ...coverage, metricInsight: { ...snapshot, queued: true } } as unknown as Prisma.InputJsonObject } });
  }
  return ids.length;
}
