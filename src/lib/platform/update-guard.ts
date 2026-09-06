/**
 * 정책 변경의 영향 범위.
 *
 * **서버 가드를 복제하지 않는다.** 관측되지 않은 버전, 탈출구 없음, 전원
 * 차단, 스토어 주소 없음은 platform Admin API가 fail-closed로 거부한다.
 * 여기서 다시 판정하면 두 곳의 규칙이 갈라지고, 그때 어느 쪽이 맞는지
 * 아무도 모른다.
 *
 * 여기서만 할 수 있는 것은 "지금 몇 명이 막히나"다. `app_versions`는 최초
 * 관측 시각만 갖고 세션 수를 세지 않으므로 서버는 이 답을 낼 수 없다.
 */

import {
  sameVersion,
  type UpdatePolicyPlatform,
  type UpdatePolicyPlatformInput,
} from "./update-policy";
import type { PlatformVersionDistribution } from "./version-distribution";

/** 이 비율을 넘으면 분포로 대상 규모를 산정할 수 없다. */
export const UNKNOWN_SHARE_LIMIT = 0.1;

/** 이 비율을 넘으면 화면이 크게 경고한다. */
export const LARGE_BLAST_SHARE = 0.3;

export interface UpdateBlastRadius {
  totalSessions: number;
  unknownSessions: number;
  /** 강제 대상 버전으로 지금 접속 중인 세션 수. */
  blockedSessions: number;
  /** 0~1. 전체 세션이 0이면 0이다. */
  blockedShare: number;
  byPlatform: Array<{ platform: string; sessions: number }>;
  warnings: UpdateGuardWarning[];
}

export type UpdateGuardWarning =
  | { code: "no_observation"; message: string }
  | { code: "unknown_share_high"; message: string }
  | { code: "large_blast"; message: string }
  | { code: "appstore_unprovable"; message: string };

function formatShare(share: number): string {
  return new Intl.NumberFormat("ko-KR", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(share);
}

/**
 * 강제 대상이 지금 얼마나 많은 세션을 끊는지 센다.
 *
 * presence는 최근 150초 창이라 "지금 접속 중"만 답한다. 과거 시점 분포는
 * 존재하지 않으므로 이 숫자를 채택률로 읽으면 안 된다.
 */
export function evaluateUpdateBlastRadius(
  distribution: PlatformVersionDistribution | null,
  next: readonly UpdatePolicyPlatformInput[],
): UpdateBlastRadius {
  const warnings: UpdateGuardWarning[] = [];
  const blockedByPlatform = new Map<string, number>();
  let blockedSessions = 0;

  const totalSessions = distribution?.totalSessions ?? 0;
  const unknownSessions = distribution?.unknownSessions ?? 0;

  for (const entry of next) {
    if (entry.blockedVersions.length === 0) continue;
    for (const row of distribution?.versions ?? []) {
      if (row.appVersion === "") continue;
      if (!entry.blockedVersions.some((version) => sameVersion(version, row.appVersion))) {
        continue;
      }
      for (const platform of row.byPlatform) {
        if (platform.platform !== entry.platform) continue;
        blockedSessions += platform.sessions;
        blockedByPlatform.set(
          platform.platform,
          (blockedByPlatform.get(platform.platform) ?? 0) + platform.sessions,
        );
      }
    }
  }

  const blockedShare = totalSessions === 0 ? 0 : blockedSessions / totalSessions;

  if (totalSessions === 0) {
    warnings.push({
      code: "no_observation",
      message:
        "지금 접속 중인 세션이 없어 영향 범위를 알 수 없습니다. 저장은 되지만 규모는 확인되지 않습니다.",
    });
  } else if (unknownSessions / totalSessions > UNKNOWN_SHARE_LIMIT) {
    warnings.push({
      code: "unknown_share_high",
      message: `버전을 보고하지 않은 세션이 ${formatShare(unknownSessions / totalSessions)}입니다. 실제 차단 규모는 이 숫자보다 클 수 있습니다.`,
    });
  }

  if (blockedShare > LARGE_BLAST_SHARE) {
    warnings.push({
      code: "large_blast",
      message: `지금 접속 중인 세션의 ${formatShare(blockedShare)}가 즉시 막힙니다.`,
    });
  }

  if (next.some((entry) => entry.platform === "ios" && entry.blockedVersions.length > 0)) {
    warnings.push({
      code: "appstore_unprovable",
      message:
        "App Store 공개 상태는 백오피스 DB로 증명할 수 없습니다. 릴리스 기록은 업로드까지만 나타내므로 iOS 실제 세션을 근거로 삼으세요.",
    });
  }

  return {
    totalSessions,
    unknownSessions,
    blockedSessions,
    blockedShare,
    byPlatform: [...blockedByPlatform.entries()]
      .map(([platform, sessions]) => ({ platform, sessions }))
      .sort((left, right) => right.sessions - left.sessions),
    warnings,
  };
}

/** 감사에 남길 영향 범위 스냅샷. 세션 수와 버전 문자열뿐이라 PII가 없다. */
export function blastRadiusAuditPayload(
  radius: UpdateBlastRadius,
  next: readonly UpdatePolicyPlatformInput[],
): Record<string, unknown> {
  const platforms: Record<string, unknown> = {};
  for (const entry of next) {
    platforms[entry.platform] = {
      blockedVersions: [...entry.blockedVersions].sort(),
      recommendOverride: entry.recommendOverride,
    };
  }
  return {
    platforms,
    blastRadius: {
      total: radius.totalSessions,
      blocked: radius.blockedSessions,
      unknown: radius.unknownSessions,
      byPlatform: Object.fromEntries(
        radius.byPlatform.map(({ platform, sessions }) => [platform, sessions]),
      ),
    },
    warnings: radius.warnings.map((warning) => warning.code),
  };
}

export type { UpdatePolicyPlatform };
