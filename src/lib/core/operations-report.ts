import { prisma } from "@/lib/prisma";
import { kstDateTime } from "@/lib/format/kst";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { metricDayOf, metricDayStart } from "@/lib/analytics/metric-day";
import { EMBED_COLOR } from "@/lib/notifications/style";

export async function sendOperationsSummary(now: Date): Promise<{
  refDate: string;
  events: number;
  notificationsQueued: number;
}> {
  const refDate = metricDayOf(now);
  const start = metricDayStart(refDate);
  const rows = await prisma.operationalEvent.groupBy({
    by: ["appId", "eventType"],
    where: { occurredAt: { gte: start, lte: now } },
    _count: { _all: true },
    orderBy: [{ appId: "asc" }, { eventType: "asc" }],
  });
  const appIds = [...new Set(rows.map((row) => row.appId))];
  // operational_event.appId 는 Platform registry app_id 다. slug 로만 찾으면 둘이
  // 다른 앱(운글=ungeul/saju-reader)이 표시명 없이 원시 ID 로 찍힌다.
  // 수신 라우트(operational-events/route.ts)와 같은 조회 규칙을 쓴다.
  const apps = await prisma.app.findMany({
    where: {
      OR: [
        { platformAppId: { in: appIds } },
        { platformAppId: null, slug: { in: appIds } },
      ],
    },
    select: { slug: true, platformAppId: true, displayName: true },
  });
  const names = new Map(apps.map((app) => [app.platformAppId ?? app.slug, app.displayName]));
  const latest = await prisma.platformUserMetricSample.findFirst({
    orderBy: { capturedAt: "desc" },
  });
  const labels: Record<string, string> = {
    "identity.created": "신규 사용자",
    "iap.granted": "IAP 지급",
    "ad.reward.delivered": "광고 보상",
  };
  const lines = [`🌙 **당일 운영 요약** (${refDate} 00:00~22:30 KST, 잠정)`];
  if (rows.length === 0) {
    lines.push("확정 운영 이벤트 없음");
  } else {
    let current = "";
    for (const row of rows) {
      if (row.appId !== current) {
        current = row.appId;
        lines.push("", `**${names.get(row.appId) ?? row.appId}**`);
      }
      lines.push(`- ${labels[row.eventType] ?? row.eventType}: ${row._count._all}건`);
    }
  }
  if (latest) {
    lines.push(
      "",
      `**Platform 활성 현황** · 전체 ${latest.totalUsers} · 최근 1시간 ${latest.hourlyActiveUsers} · 최근 24시간 ${latest.dailyActiveUsers} · 최근 7일 ${latest.weeklyActiveUsers}`,
      `수집 시각 ${kstDateTime(latest.capturedAt)}`,
    );
  } else {
    lines.push("", "⚠️ Platform 활성 사용자 스냅샷 없음");
  }

  const destinations = discordDestinations(["metrics-daily"]);
  await enqueueNotification({
    dedupeKey: `metrics:operations:${refDate}`,
    kind: "OPERATIONS_SUMMARY",
    payload: {
      text: lines.join("\n"),
      embed: { color: EMBED_COLOR.NEUTRAL },
    },
    destinations,
  });
  return {
    refDate,
    events: rows.reduce((sum, row) => sum + row._count._all, 0),
    notificationsQueued: destinations.length,
  };
}
