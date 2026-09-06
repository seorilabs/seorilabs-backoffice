import { parseStableSemVerTag } from "@/lib/core/stable-semver";
import { prisma } from "@/lib/prisma";

import { resolvedPlatformAppId, type PlatformAppBinding } from "./app-id";
import { PRESENCE_ACTIVE_TTL_SECONDS, activePresenceWhere } from "./presence";

export const APP_VERSION_FIRST_SEEN_EVENT = "app.version.first_seen";

/**
 * 버전을 보고하지 않은 세션 버킷.
 *
 * SDK가 `X-Seori-AppVer`를 선택값으로 보내므로 빈 문자열이 실제로 들어온다.
 * 최신에도 구버전에도 합치지 않는다. 합치면 어느 쪽이든 거짓말이 된다.
 */
export const UNKNOWN_APP_VERSION = "";

export interface PlatformVersionPlatformCount {
  platform: string;
  sessions: number;
}

export interface PlatformVersionRow {
  /** 표시용 원문. 빈 문자열이면 미상 버킷이다. */
  appVersion: string;
  sessions: number;
  /** 0~1. 전체 활성 세션이 0이면 0이다. */
  share: number;
  byPlatform: PlatformVersionPlatformCount[];
  lastSeenAt: string | null;
  /** 그 빌드로 세션이 처음 열린 시각. 관측 이벤트가 없으면 null이다. */
  firstSeenAt: string | null;
  runtimes: string[];
}

export interface PlatformVersionDistribution {
  appId: string;
  displayName: string;
  measuredAt: string;
  activeTtlSeconds: number;
  totalSessions: number;
  /** 버전을 보고하지 않은 세션 수. 분포 해석의 신뢰도를 가른다. */
  unknownSessions: number;
  versions: PlatformVersionRow[];
}

export interface PresenceVersionGroup {
  appId: string;
  platform: string;
  appVersion: string;
  _count: { _all: number };
  _max: { lastSeenAt: Date | null };
}

export interface AppVersionFirstSeenRow {
  appId: string;
  occurredAt: Date;
  attributes: unknown;
}

/**
 * 버전 문자열을 비교·결합용 키로 바꾼다.
 *
 * presence와 관측 이벤트가 같은 헤더에서 오지만 앱마다 `v` 접두사 유무가
 * 갈릴 수 있어 원문으로 join하면 같은 빌드가 두 줄로 쪼개진다.
 */
export function appVersionKey(raw: string): string {
  return raw.trim().replace(/^v/i, "");
}

/**
 * 표시 순서를 정한다.
 *
 * 안정 SemVer가 먼저(내림차순), 그다음 해석 불가 문자열, 미상이 맨 아래다.
 * 미상을 최신 옆에 두면 운영자가 그걸 최신 버전으로 읽는다.
 */
export function compareVersionRows(
  left: PlatformVersionRow,
  right: PlatformVersionRow,
): number {
  const leftUnknown = left.appVersion === UNKNOWN_APP_VERSION;
  const rightUnknown = right.appVersion === UNKNOWN_APP_VERSION;
  if (leftUnknown !== rightUnknown) return leftUnknown ? 1 : -1;
  if (leftUnknown) return 0;

  const leftParts = parseStableSemVerTag(left.appVersion);
  const rightParts = parseStableSemVerTag(right.appVersion);
  if (leftParts && rightParts) {
    for (let index = 0; index < leftParts.length; index += 1) {
      const difference = rightParts[index] - leftParts[index];
      if (difference !== 0) return difference;
    }
    return 0;
  }
  if (leftParts) return -1;
  if (rightParts) return 1;
  return right.appVersion.localeCompare(left.appVersion, "en");
}

interface FirstSeenAttributes {
  appVersion: string;
  runtime: string;
}

/** 관측 이벤트의 attributes는 Json이라 값이 없거나 형이 다를 수 있다. */
export function readFirstSeenAttributes(
  attributes: unknown,
): FirstSeenAttributes | null {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return null;
  }
  const record = attributes as Record<string, unknown>;
  const appVersion = record.appVersion;
  if (typeof appVersion !== "string" || appVersion.trim() === "") return null;
  const runtime = record.runtime;
  return {
    appVersion: appVersion.trim(),
    runtime: typeof runtime === "string" ? runtime.trim() : "",
  };
}

interface VersionAccumulator {
  label: string;
  sessions: number;
  byPlatform: Map<string, number>;
  lastSeenAt: Date | null;
  firstSeenAt: Date | null;
  runtimes: Set<string>;
}

function emptyAccumulator(label: string): VersionAccumulator {
  return {
    label,
    sessions: 0,
    byPlatform: new Map(),
    lastSeenAt: null,
    firstSeenAt: null,
    runtimes: new Set(),
  };
}

/**
 * DB 의존부와 표현 조립을 분리해 미상 버킷·0건·미관측 앱 계약을 단위 검증한다.
 *
 * presence에만 있는 버전(지금 접속 중)과 관측 이벤트에만 있는 버전(유입은
 * 됐지만 지금은 아무도 안 씀)을 모두 남긴다. 뒤쪽이 빠지면 "이 버전이 실제로
 * 돌긴 했나"를 나중에 확인할 방법이 사라진다.
 */
export function buildPlatformVersionDistributions(
  now: Date,
  apps: readonly (PlatformAppBinding & { displayName: string })[],
  groups: readonly PresenceVersionGroup[],
  firstSeen: readonly AppVersionFirstSeenRow[],
): PlatformVersionDistribution[] {
  const byApp = new Map<string, Map<string, VersionAccumulator>>();
  const ensure = (appId: string, version: string): VersionAccumulator => {
    const versions = byApp.get(appId) ?? new Map<string, VersionAccumulator>();
    byApp.set(appId, versions);
    const key = version === UNKNOWN_APP_VERSION ? UNKNOWN_APP_VERSION : appVersionKey(version);
    const existing = versions.get(key) ?? emptyAccumulator(version);
    versions.set(key, existing);
    return existing;
  };

  for (const group of groups) {
    const bucket = ensure(group.appId, group.appVersion);
    bucket.sessions += group._count._all;
    bucket.byPlatform.set(
      group.platform,
      (bucket.byPlatform.get(group.platform) ?? 0) + group._count._all,
    );
    const seenAt = group._max.lastSeenAt;
    if (seenAt && (!bucket.lastSeenAt || seenAt > bucket.lastSeenAt)) {
      bucket.lastSeenAt = seenAt;
    }
  }

  for (const row of firstSeen) {
    const attributes = readFirstSeenAttributes(row.attributes);
    if (!attributes) continue;
    const bucket = ensure(row.appId, attributes.appVersion);
    if (!bucket.firstSeenAt || row.occurredAt < bucket.firstSeenAt) {
      bucket.firstSeenAt = row.occurredAt;
    }
    if (attributes.runtime) bucket.runtimes.add(attributes.runtime);
  }

  const distributions: PlatformVersionDistribution[] = [];
  for (const app of apps) {
    const appId = resolvedPlatformAppId(app);
    const versions = byApp.get(appId);
    if (!versions || versions.size === 0) continue;

    const totalSessions = [...versions.values()].reduce(
      (total, bucket) => total + bucket.sessions,
      0,
    );
    const rows = [...versions.values()]
      .map<PlatformVersionRow>((bucket) => ({
        appVersion: bucket.label,
        sessions: bucket.sessions,
        share: totalSessions === 0 ? 0 : bucket.sessions / totalSessions,
        byPlatform: [...bucket.byPlatform.entries()]
          .map(([platform, sessions]) => ({ platform, sessions }))
          .sort(
            (left, right) =>
              right.sessions - left.sessions ||
              left.platform.localeCompare(right.platform, "en"),
          ),
        lastSeenAt: bucket.lastSeenAt?.toISOString() ?? null,
        firstSeenAt: bucket.firstSeenAt?.toISOString() ?? null,
        runtimes: [...bucket.runtimes].sort((left, right) =>
          left.localeCompare(right, "en"),
        ),
      }))
      .sort(compareVersionRows);

    distributions.push({
      appId,
      displayName: app.displayName,
      measuredAt: now.toISOString(),
      activeTtlSeconds: PRESENCE_ACTIVE_TTL_SECONDS,
      totalSessions,
      unknownSessions:
        versions.get(UNKNOWN_APP_VERSION)?.sessions ?? 0,
      versions: rows,
    });
  }

  return distributions.sort(
    (left, right) =>
      right.totalSessions - left.totalSessions ||
      left.displayName.localeCompare(right.displayName, "ko"),
  );
}

/**
 * 앱 목록 전체의 버전 분포를 두 번의 조회로 읽는다.
 *
 * 앱마다 조회하면 앱 수만큼 쿼리가 늘고, 그중 하나가 느려지면 화면 전체가
 * 그만큼 늦어진다. presence는 `(app_id, expires_at)`, 관측 이벤트는
 * `(app_id, event_type, occurred_at)` 인덱스를 그대로 탄다.
 */
export async function loadPlatformVersionDistributions(
  apps: readonly (PlatformAppBinding & { displayName: string })[],
  now = new Date(),
): Promise<PlatformVersionDistribution[]> {
  const appIds = apps.map(resolvedPlatformAppId);
  if (appIds.length === 0) return [];

  const [groups, firstSeen] = await Promise.all([
    prisma.platformPresenceSession.groupBy({
      by: ["appId", "platform", "appVersion"],
      where: { appId: { in: appIds }, ...activePresenceWhere(now) },
      _count: { _all: true },
      _max: { lastSeenAt: true },
    }),
    prisma.operationalEvent.findMany({
      where: { appId: { in: appIds }, eventType: APP_VERSION_FIRST_SEEN_EVENT },
      select: { appId: true, occurredAt: true, attributes: true },
      orderBy: { occurredAt: "asc" },
    }),
  ]);

  return buildPlatformVersionDistributions(now, apps, groups, firstSeen);
}
