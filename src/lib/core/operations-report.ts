import { prisma } from "@/lib/prisma";
import { metricDayOf, metricDayStart } from "@/lib/analytics/metric-day";
/** 운영 이벤트 집계는 내부 원장이다. 중요한 비교는 종합 보고서 한 경로에서 발행한다. */
export async function sendOperationsSummary(now: Date) {
  const refDate = metricDayOf(now);
  const events = await prisma.operationalEvent.count({
    where: { occurredAt: { gte: metricDayStart(refDate), lte: now } },
  });
  return { refDate, events, notificationsQueued: 0 };
}
