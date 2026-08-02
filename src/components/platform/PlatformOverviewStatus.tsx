import React from "react";

import {
  capabilityPresentation,
  connectionPresentation,
  deadLetterPresentation,
  environmentPresentation,
  type PlatformCapabilityState,
  type PlatformConnectionState,
} from "./presentation";
import {
  PlatformBadge,
  PlatformEmptyState,
  PlatformPanel,
  formatPlatformTimestamp,
} from "./PlatformUi";

export interface PlatformCapabilityView {
  key: string;
  label: string;
  state: PlatformCapabilityState;
  description?: string;
}

export interface PlatformOverviewStatusProps {
  connection: PlatformConnectionState;
  environment?: string | null;
  deadLetterCount?: number | null;
  capabilities?: readonly PlatformCapabilityView[];
  lastCheckedAt?: string | null;
  message?: string | null;
}

/** 플랫폼 개요 페이지에서 사용하는 읽기 전용 상태 표현이다. */
export function PlatformOverviewStatus({
  connection,
  environment,
  deadLetterCount,
  capabilities = [],
  lastCheckedAt,
  message,
}: PlatformOverviewStatusProps) {
  const connectionView = connectionPresentation(connection);
  const environmentView = environmentPresentation(environment);
  const deadLetterView = deadLetterPresentation(deadLetterCount);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatusCard
          label="Admin API"
          value={connectionView.label}
          tone={connectionView.tone}
          detail={
            lastCheckedAt
              ? `마지막 확인 ${formatPlatformTimestamp(lastCheckedAt)}`
              : "아직 확인하지 않았습니다."
          }
        />
        <StatusCard
          label="현재 환경"
          value={environmentView.label}
          tone={environmentView.tone}
          detail="변경 작업 전 반드시 원장 환경을 확인하세요."
        />
        <StatusCard
          label="IAP dead-letter"
          value={deadLetterView.label}
          tone={deadLetterView.tone}
          detail="0이 아니면 마켓 완료 처리 상태를 점검해야 합니다."
        />
      </div>

      {message && (
        <div
          role={connection === "unavailable" ? "alert" : "status"}
          className={`rounded-lg border px-4 py-3 text-sm ${
            connection === "unavailable"
              ? "border-red-200 bg-red-50 text-red-700"
              : connection === "degraded"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-neutral-200 bg-white text-neutral-600"
          }`}
        >
          {message}
        </div>
      )}

      <PlatformPanel
        title="공통 기능"
        description="Admin API가 실제로 제공한다고 확인된 기능만 표시합니다."
      >
        {capabilities.length === 0 ? (
          <PlatformEmptyState title="확인된 기능이 없습니다">
            플랫폼 연결 또는 capability 조회 상태를 확인하세요.
          </PlatformEmptyState>
        ) : (
          <div className="divide-y divide-neutral-100">
            {capabilities.map((capability) => {
              const view = capabilityPresentation(capability.state);
              return (
                <div
                  key={capability.key}
                  className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
                >
                  <div>
                    <div className="text-sm font-medium text-neutral-800">
                      {capability.label}
                    </div>
                    {capability.description && (
                      <div className="mt-0.5 text-xs text-neutral-500">
                        {capability.description}
                      </div>
                    )}
                  </div>
                  <PlatformBadge tone={view.tone}>{view.label}</PlatformBadge>
                </div>
              );
            })}
          </div>
        )}
      </PlatformPanel>
    </div>
  );
}

function StatusCard({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string;
  tone: ReturnType<typeof connectionPresentation>["tone"];
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-xs font-medium text-neutral-500">{label}</div>
      <div className="mt-2">
        <PlatformBadge tone={tone}>{value}</PlatformBadge>
      </div>
      <p className="mt-2 text-[11px] leading-4 text-neutral-400">{detail}</p>
    </div>
  );
}
