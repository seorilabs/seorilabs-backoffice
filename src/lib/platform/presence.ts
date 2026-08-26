import { prisma } from "@/lib/prisma";

export const PRESENCE_ACTIVE_TTL_SECONDS = 150;

export interface PlatformPresenceAppSnapshot {
  appId: string;
  displayName: string;
  activeSessions: number;
  lastSeenAt: string;
}

export interface PlatformPresenceSnapshot {
  totalActiveSessions: number;
  measuredAt: string;
  activeTtlSeconds: number;
  apps: PlatformPresenceAppSnapshot[];
}

interface PresenceGroup {
  appId: string;
  _count: { _all: number };
  _max: { lastSeenAt: Date | null };
}

interface AppLabel {
  slug: string;
  platformAppId: string | null;
  displayName: string;
}

export function activePresenceWhere(now: Date) {
  return { expiresAt: { gt: now } } as const;
}

/** DB 의존부와 표현 조립을 분리해 0건·미등록 앱 계약을 단위 검증한다. */
export function buildPlatformPresenceSnapshot(
  now: Date,
  groups: readonly PresenceGroup[],
  appLabels: readonly AppLabel[],
): PlatformPresenceSnapshot {
  const labels = new Map(
    appLabels.map((app) => [app.platformAppId ?? app.slug, app.displayName]),
  );
  const apps = groups
    .map((group) => ({
      appId: group.appId,
      displayName: labels.get(group.appId) ?? group.appId,
      activeSessions: group._count._all,
      lastSeenAt: (group._max.lastSeenAt ?? now).toISOString(),
    }))
    .sort(
      (left, right) =>
        right.activeSessions - left.activeSessions ||
        left.displayName.localeCompare(right.displayName, "ko"),
    );

  return {
    totalActiveSessions: apps.reduce(
      (total, app) => total + app.activeSessions,
      0,
    ),
    measuredAt: now.toISOString(),
    activeTtlSeconds: PRESENCE_ACTIVE_TTL_SECONDS,
    apps,
  };
}

export async function loadPlatformPresenceSnapshot(
  now = new Date(),
): Promise<PlatformPresenceSnapshot> {
  const groups = await prisma.platformPresenceSession.groupBy({
    by: ["appId"],
    where: activePresenceWhere(now),
    _count: { _all: true },
    _max: { lastSeenAt: true },
  });
  const appIds = groups.map((group) => group.appId);
  const appLabels = appIds.length
    ? await prisma.app.findMany({
        where: {
          OR: [
            { platformAppId: { in: appIds } },
            { platformAppId: null, slug: { in: appIds } },
          ],
        },
        select: { slug: true, platformAppId: true, displayName: true },
      })
    : [];

  return buildPlatformPresenceSnapshot(now, groups, appLabels);
}
