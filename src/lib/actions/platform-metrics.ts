"use server";

import { requirePlatformReadAccess } from "@/lib/platform/access";
import type { PlatformMetricSample } from "@/lib/platform/metric-samples";
import { prisma } from "@/lib/prisma";

/** 그래프가 기본으로 보는 구간. 7일 × 24시간이면 168점이다. */
const DEFAULT_HOURS = 24 * 7;

/**
 * 저장된 플랫폼 지표 시계열을 오래된 순으로 읽는다.
 *
 * 백필이 불가능하므로 수집 시작 이전 구간은 존재하지 않는다. 빈 배열은
 * 장애가 아니라 "아직 모으는 중"일 수 있어 화면이 구분해야 한다.
 */
export async function loadPlatformMetricSamplesAction(
  hours: number = DEFAULT_HOURS,
): Promise<PlatformMetricSample[]> {
  await requirePlatformReadAccess();

  const span = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 90) : DEFAULT_HOURS;
  const since = new Date(Date.now() - span * 60 * 60 * 1000);

  const rows = await prisma.platformUserMetricSample.findMany({
    where: { capturedAt: { gte: since } },
    orderBy: { capturedAt: "asc" },
    select: {
      capturedAt: true,
      totalUsers: true,
      hourlyActiveUsers: true,
      dailyActiveUsers: true,
      weeklyActiveUsers: true,
    },
  });

  return rows.map((row) => ({
    capturedAt: row.capturedAt.toISOString(),
    totalUsers: row.totalUsers,
    hourlyActiveUsers: row.hourlyActiveUsers,
    dailyActiveUsers: row.dailyActiveUsers,
    weeklyActiveUsers: row.weeklyActiveUsers,
  }));
}
