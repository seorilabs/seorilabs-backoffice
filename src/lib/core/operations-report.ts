import { prisma } from "@/lib/prisma";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

export function kstDayStart(now: Date): Date {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  const utcMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(utcMidnight - KST_OFFSET_MS);
}

export async function sendOperationsSummary(now: Date): Promise<{
  refDate: string;
  events: number;
  notificationsQueued: number;
}> {
  const start = kstDayStart(now);
  const rows = await prisma.operationalEvent.groupBy({
    by: ["appId", "eventType"],
    where: { occurredAt: { gte: start, lte: now } },
    _count: { _all: true },
    orderBy: [{ appId: "asc" }, { eventType: "asc" }],
  });
  const appIds = [...new Set(rows.map((row) => row.appId))];
  const apps = await prisma.app.findMany({
    where: { slug: { in: appIds } },
    select: { slug: true, displayName: true },
  });
  const names = new Map(apps.map((app) => [app.slug, app.displayName]));
  const latest = await prisma.platformUserMetricSample.findFirst({
    orderBy: { capturedAt: "desc" },
  });
  const refDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const labels: Record<string, string> = {
    "identity.created": "신규 사용자",
    "iap.granted": "IAP 지급",
    "ad.reward.delivered": "광고 보상",
    "iap.completion_failed": "IAP 완료 실패",
    "ad.reward.delivery_failed": "광고 지급 실패",
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
      `수집 시각 ${latest.capturedAt.toISOString()}`,
    );
  } else {
    lines.push("", "⚠️ Platform 활성 사용자 스냅샷 없음");
  }

  const destinations = discordDestinations(["metrics-daily"]);
  await enqueueNotification({
    dedupeKey: `metrics:operations:${refDate}`,
    kind: "OPERATIONS_SUMMARY",
    payload: { discordMarkdown: lines.join("\n") },
    destinations,
  });
  return {
    refDate,
    events: rows.reduce((sum, row) => sum + row._count._all, 0),
    notificationsQueued: destinations.length,
  };
}
