import React from "react";

import type {
  PlatformVersionDistribution,
  PlatformVersionRow,
} from "@/lib/platform/version-distribution";
import { UNKNOWN_APP_VERSION } from "@/lib/platform/version-distribution";

import {
  PlatformBadge,
  PlatformEmptyState,
  PlatformPanel,
  formatPlatformCount,
  formatPlatformTimestamp,
} from "./PlatformUi";

/** 이 비율을 넘으면 분포로 차단 대상 규모를 산정할 수 없다. */
export const UNKNOWN_VERSION_WARN_SHARE = 0.1;

export type PlatformVersionDistributionState = "available" | "unavailable";

export interface PlatformVersionDistributionViewProps {
  state: PlatformVersionDistributionState;
  distributions: readonly PlatformVersionDistribution[];
  error?: string | null;
}

function formatShare(share: number): string {
  return new Intl.NumberFormat("ko-KR", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(share);
}

/**
 * 지금 접속 중인 세션의 앱 버전 분포를 그린다.
 *
 * presence 집계가 신뢰할 수 없을 때 0%를 그리지 않는다. Edge 장애로 만료된
 * 행을 "아무도 안 쓴다"로 읽으면 그 다음 판단이 전부 틀어진다.
 */
export function PlatformVersionDistributionView({
  state,
  distributions,
  error = null,
}: PlatformVersionDistributionViewProps) {
  return (
    <PlatformPanel
      title="앱 버전 분포"
      description="지금 접속 중인 세션이 어느 빌드에서 오는지 봅니다."
      trailing={
        state === "available" ? (
          <PlatformBadge tone="green">집계 정상</PlatformBadge>
        ) : (
          <PlatformBadge tone="amber">알 수 없음</PlatformBadge>
        )
      }
    >
      {state === "unavailable" ? (
        <PlatformEmptyState title="버전 분포 알 수 없음">
          {error ?? "RPI Edge 또는 집계 DB가 응답하지 않습니다."} 장애 중 만료된
          세션을 0명으로 표시하지 않습니다.
        </PlatformEmptyState>
      ) : distributions.length === 0 ? (
        <PlatformEmptyState title="관측된 빌드가 없습니다">
          활성 세션도 버전 첫 유입 기록도 아직 없습니다. 앱이 최신 SDK로
          `X-Seori-AppVer`를 보내기 시작하면 여기에 쌓입니다.
        </PlatformEmptyState>
      ) : (
        <div className="divide-y divide-neutral-100">
          {distributions.map((distribution) => (
            <AppVersionSection key={distribution.appId} distribution={distribution} />
          ))}
        </div>
      )}
      <div className="border-t border-neutral-100 px-4 py-3 text-[11px] leading-4 text-neutral-500">
        세션 수는 최근 {distributions[0]?.activeTtlSeconds ?? 150}초 안에 heartbeat가
        도착한 익명 세션입니다. <strong>만료된 행은 삭제되므로 과거 시점의 분포는
        복원할 수 없습니다.</strong> 세션이 0인 버전은 유입 기록만 남은 빌드로,
        그 빌드로 실제 세션이 열렸다는 증거입니다.
      </div>
    </PlatformPanel>
  );
}

function AppVersionSection({
  distribution,
}: {
  distribution: PlatformVersionDistribution;
}) {
  const unknownShare =
    distribution.totalSessions === 0
      ? 0
      : distribution.unknownSessions / distribution.totalSessions;

  return (
    <section className="px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-neutral-900">
            {distribution.displayName}
          </div>
          <div className="truncate font-mono text-[10px] text-neutral-400">
            {distribution.appId}
          </div>
        </div>
        <div className="text-sm font-semibold tabular-nums text-neutral-900">
          {formatPlatformCount(distribution.totalSessions)}명 활성
        </div>
      </div>

      {unknownShare > UNKNOWN_VERSION_WARN_SHARE && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800">
          버전을 보고하지 않은 세션이 {formatShare(unknownShare)}입니다. 구버전 SDK가
          섞여 있을 수 있어 이 분포로 대상 규모를 산정하면 실제보다 작게 나옵니다.
        </p>
      )}

      <div className="mt-3 divide-y divide-neutral-100 rounded-lg border border-neutral-200">
        {distribution.versions.map((version) => (
          <VersionRow key={version.appVersion || "unknown"} version={version} />
        ))}
      </div>
    </section>
  );
}

function VersionRow({ version }: { version: PlatformVersionRow }) {
  const unknown = version.appVersion === UNKNOWN_APP_VERSION;
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <span
            className={`text-sm font-medium ${unknown ? "text-neutral-500" : "font-mono text-neutral-800"}`}
          >
            {unknown ? "미상" : version.appVersion}
          </span>
          {version.byPlatform.length > 0 && (
            <span className="ml-2 text-[11px] text-neutral-500">
              {version.byPlatform
                .map((entry) => `${entry.platform} ${entry.sessions}`)
                .join(" · ")}
            </span>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold tabular-nums text-neutral-900">
            {formatPlatformCount(version.sessions)}명
          </div>
          <div className="text-[11px] tabular-nums text-neutral-500">
            {formatShare(version.share)}
          </div>
        </div>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-100">
        <div
          className={`h-full rounded-full ${unknown ? "bg-neutral-300" : "bg-blue-400"}`}
          style={{ width: `${Math.round(version.share * 1000) / 10}%` }}
        />
      </div>
      <div className="mt-1.5 text-[11px] text-neutral-500">
        {version.firstSeenAt
          ? `첫 유입 ${formatPlatformTimestamp(version.firstSeenAt)}`
          : "첫 유입 기록 없음"}
        {version.runtimes.length > 0 && ` · ${version.runtimes.join(", ")}`}
      </div>
    </div>
  );
}
