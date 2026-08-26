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
  formatPlatformCount,
  formatPlatformTimestamp,
} from "./PlatformUi";

export interface PlatformCapabilityView {
  key: string;
  label: string;
  state: PlatformCapabilityState;
  description?: string;
}

export interface PlatformEnvironmentMismatchView {
  appId: string;
  registry: string;
  ledger: string;
}

/** 실패한 개별 조회. 다른 구획의 값은 그대로 살아 있다. */
export interface PlatformSectionFailureView {
  section: string;
  label: string;
  error: string;
}

export interface PlatformUserMetricsView {
  totalUsers: number;
  hourlyActiveUsers: number;
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  activitySource: string;
  measuredAt: string;
}

export interface PlatformOverviewStatusProps {
  connection: PlatformConnectionState;
  environment?: string | null;
  deadLetterCount?: number | null;
  environmentMismatches?: readonly PlatformEnvironmentMismatchView[];
  capabilities?: readonly PlatformCapabilityView[];
  sectionFailures?: readonly PlatformSectionFailureView[];
  /** 계약 위반으로 목록에서 제외된 건수. 실패가 아니라 불완전이다. */
  hiddenOrderCount?: number;
  hiddenOperatorRecordCount?: number;
  metrics?: PlatformUserMetricsView | null;
  /** 지표 endpoint가 없는 구버전 Admin API를 만났는지. 실패와 다르다. */
  metricsUnsupported?: boolean;
  lastCheckedAt?: string | null;
  message?: string | null;
}

/** 플랫폼 개요 페이지에서 사용하는 읽기 전용 상태 표현이다. */
export function PlatformOverviewStatus({
  connection,
  environment,
  deadLetterCount,
  environmentMismatches = [],
  capabilities = [],
  sectionFailures = [],
  hiddenOrderCount = 0,
  hiddenOperatorRecordCount = 0,
  metrics,
  metricsUnsupported = false,
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

      {environmentMismatches.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          <div className="font-medium">
            레지스트리와 원장 환경이 어긋나 운영 조작이 막혀 있습니다.
          </div>
          <ul className="mt-2 space-y-1">
            {environmentMismatches.map((m) => (
              <li key={m.appId} className="font-mono text-xs">
                {m.appId} — 레지스트리 {m.registry || "(미선언)"} / 원장 {m.ledger}
              </li>
            ))}
          </ul>
          <div className="mt-2 text-xs">
            해당 앱의 지급·회수가 전부 실패합니다. 유저 결제는 정상이라 다른
            지표로는 드러나지 않습니다. platform 저장소에서{" "}
            <span className="font-mono">registry/apps/*.json</span>을 고친 뒤{" "}
            <span className="font-mono">cmd/regsync</span>를 실행해야 합니다 —
            파일만 고치면 반영되지 않습니다.
          </div>
        </div>
      )}

      {sectionFailures.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <div className="font-medium">
            일부 조회가 실패했습니다. 나머지 상태 표시는 유효합니다.
          </div>
          <ul className="mt-2 space-y-1">
            {sectionFailures.map((f) => (
              <li key={f.section} className="text-xs">
                <span className="font-medium">{f.label}</span> — {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(hiddenOrderCount > 0 || hiddenOperatorRecordCount > 0) && (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <div className="font-medium">
            계약을 만족하지 않아 목록에서 제외된 기록이 있습니다.
          </div>
          <ul className="mt-2 space-y-1 text-xs">
            {hiddenOperatorRecordCount > 0 && (
              <li>운영자 변경 이력 {hiddenOperatorRecordCount}건 제외됨</li>
            )}
            {hiddenOrderCount > 0 && <li>최근 주문 {hiddenOrderCount}건 제외됨</li>}
          </ul>
          <div className="mt-2 text-xs">
            {/*
              감사 이력에서 조용한 누락은 잘못된 결론으로 이어진다.
              짧아진 목록을 보고 "지급한 적 없다"고 판단하면 안 된다.
            */}
            <span className="font-medium">
              이 목록은 불완전합니다. 없는 것으로 판단하지 마세요.
            </span>{" "}
            제외된 기록은 자유 서술 사유나 이메일 원문 같은 계약 밖 값을 담고
            있어 브라우저로 내보내지 않습니다. 어느 문서의 어느 필드인지는
            platform Cloud Logging의{" "}
            <span className="font-mono">invalid_fields</span> 경고 로그에
            남습니다.
          </div>
        </div>
      )}

      <PlatformPanel
        title="플랫폼 사용자"
        description="앱을 가로지르는 플랫폼 전체 규모입니다. IAP 원장 환경과 무관하게 배포 환경 전체를 셉니다."
      >
        {metrics ? (
          <>
            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                label="전체 사용자"
                value={formatPlatformCount(metrics.totalUsers)}
                detail="플랫폼이 발급한 사용자 ID 총계"
              />
              <MetricCard
                label="1시간 활성"
                value={formatPlatformCount(metrics.hourlyActiveUsers)}
                detail="최근 1시간 세션 발급 사용자"
              />
              <MetricCard
                label="DAU"
                value={formatPlatformCount(metrics.dailyActiveUsers)}
                detail="최근 24시간 세션 발급 사용자"
              />
              <MetricCard
                label="WAU"
                value={formatPlatformCount(metrics.weeklyActiveUsers)}
                detail="최근 7일 세션 발급 사용자"
              />
            </div>
            <div className="border-t border-neutral-100 px-4 py-3 text-[11px] leading-4 text-neutral-500">
              {/*
                이 한 줄을 빼면 안 된다. 정의를 모르면 GA4 DAU와 숫자가
                다른 것이 버그로 보이고, 실제로는 정상 동작이다.
              */}
              활성 판정은 세션 발급·갱신 시각 기준입니다. 앱을 열었지만 토큰이
              아직 유효해 재발급이 없었던 사용자는 세지 않으므로 GA4 DAU보다
              작게 나옵니다. 동시 접속은 아래 RPI Edge의 최근 150초 heartbeat로
              별도 집계합니다.
              {metrics.activitySource !== "session_last_seen" && (
                <span className="ml-1 font-medium text-amber-700">
                  Admin API가 다른 활성 기준({metrics.activitySource})을
                  보냈습니다. 위 설명이 맞는지 확인하세요.
                </span>
              )}
              <span className="ml-1">
                집계 기준 {formatPlatformTimestamp(metrics.measuredAt)}
              </span>
            </div>
          </>
        ) : (
          <PlatformEmptyState title="사용자 지표를 표시할 수 없습니다">
            {metricsUnsupported
              ? "이 Admin API 버전에는 지표 조회가 없습니다. 플랫폼 배포 후 표시됩니다."
              : "지표 조회 상태를 확인하세요."}
          </PlatformEmptyState>
        )}
      </PlatformPanel>

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

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-xs font-medium text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900">
        {value}
      </div>
      <p className="mt-1 text-[11px] leading-4 text-neutral-400">{detail}</p>
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
