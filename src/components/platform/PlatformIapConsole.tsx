import React from "react";

import {
  deadLetterPresentation,
  environmentPresentation,
  writeStatePresentation,
  type PlatformWriteState,
} from "./presentation";
import {
  PlatformBadge,
  PlatformEmptyState,
  PlatformPanel,
  formatPlatformTimestamp,
} from "./PlatformUi";

export interface PlatformIapOrderView {
  orderKey: string;
  appId?: string | null;
  platformUserId: string;
  entitlementId: string;
  market: string;
  productId: string;
  state: string;
  purchasedAt?: string | null;
  observedAt?: string | null;
  tombstone?: boolean;
}

export interface PlatformEntitlementSourceView {
  market: string;
  productId: string;
  state: string;
  observedAt?: string | null;
}

export interface PlatformIapEntitlementView {
  entitlementId: string;
  active: boolean;
  updatedAt?: string | null;
  sources: readonly PlatformEntitlementSourceView[];
}

export interface PlatformIapOperatorRecordView {
  requestId: string;
  grantRequestId?: string | null;
  kind: "grant" | "revoke";
  appId: string;
  platformUserId: string;
  entitlementId: string;
  actorLogin?: string | null;
  reason?: string | null;
  createdAt?: string | null;
}

export interface PlatformIapWriteOperationView {
  state: PlatformWriteState;
  actionLabel?: string | null;
  summary?: string | null;
  requestId?: string | null;
}

export interface PlatformIapConsoleProps {
  environment?: string | null;
  deadLetterCount?: number | null;
  selectedPlatformUserId?: string | null;
  orders?: readonly PlatformIapOrderView[];
  entitlements?: readonly PlatformIapEntitlementView[];
  operatorRecords?: readonly PlatformIapOperatorRecordView[];
  writeOperation?: PlatformIapWriteOperationView;
  loading?: boolean;
  error?: string | null;
}

/**
 * 공통 IAP 운영 상태를 표현한다.
 *
 * props에는 receipt, purchase token, 인증 토큰, 마켓 계정 식별자 필드가
 * 의도적으로 없다. 조회와 변경 실행은 상위 라우트·action이 담당한다.
 */
export function PlatformIapConsole({
  environment,
  deadLetterCount,
  selectedPlatformUserId,
  orders = [],
  entitlements = [],
  operatorRecords = [],
  writeOperation = { state: "idle" },
  loading = false,
  error,
}: PlatformIapConsoleProps) {
  const environmentView = environmentPresentation(environment);
  const deadLetterView = deadLetterPresentation(deadLetterCount);
  const writeView = writeStatePresentation(writeOperation.state);
  const production = environment?.trim().toLowerCase() === "production";
  const sandbox = environment?.trim().toLowerCase() === "sandbox";

  return (
    <div className="space-y-4">
      <section
        aria-label="IAP 원장 환경"
        className={`rounded-lg border-2 px-4 py-3 ${
          production
            ? "border-red-300 bg-red-50"
            : sandbox
              ? "border-amber-300 bg-amber-50"
              : "border-neutral-300 bg-neutral-50"
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-neutral-900">IAP 운영 환경</h2>
              <PlatformBadge tone={environmentView.tone}>{environmentView.label}</PlatformBadge>
            </div>
            <p
              className={`mt-1 text-xs ${
                production ? "text-red-800" : sandbox ? "text-amber-900" : "text-neutral-600"
              }`}
            >
              {production
                ? "실제 사용자 entitlement에 반영되는 환경입니다. 변경 대상을 다시 확인하세요."
                : sandbox
                  ? "테스트 원장입니다. Production 데이터와 분리해 표시합니다."
                  : "환경을 확인하기 전에는 변경 작업을 실행하지 마세요."}
            </p>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-neutral-500">dead-letter</div>
            <PlatformBadge tone={deadLetterView.tone}>{deadLetterView.label}</PlatformBadge>
          </div>
        </div>
      </section>

      {loading && (
        <div role="status" className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">
          플랫폼 IAP 상태를 불러오는 중입니다…
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <PlatformPanel
        title="최근 주문"
        description="원문 영수증과 구매 토큰을 제외한 운영용 주문 요약입니다."
        trailing={<span className="text-xs text-neutral-400">{orders.length}건</span>}
      >
        {orders.length === 0 ? (
          <PlatformEmptyState title="표시할 주문이 없습니다">
            조회 결과가 없거나 아직 주문 상태를 불러오지 않았습니다.
          </PlatformEmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-neutral-200 text-left text-xs">
              <thead className="bg-neutral-50 text-neutral-500">
                <tr>
                  <th className="px-3 py-2 font-medium">주문</th>
                  <th className="px-3 py-2 font-medium">앱·마켓</th>
                  <th className="px-3 py-2 font-medium">사용자</th>
                  <th className="px-3 py-2 font-medium">Entitlement</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                  <th className="px-3 py-2 font-medium">관찰 시각</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {orders.map((order) => (
                  <tr key={order.orderKey}>
                    <td className="max-w-48 px-3 py-2">
                      <div className="truncate font-mono text-[11px] text-neutral-700">
                        {order.orderKey}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10px] text-neutral-400">
                        {order.productId}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-neutral-600">
                      <div>{order.appId ?? "앱 미확인"}</div>
                      <div className="text-[11px] text-neutral-400">{marketLabel(order.market)}</div>
                    </td>
                    <td className="max-w-48 truncate px-3 py-2 font-mono text-[11px] text-neutral-600">
                      {order.platformUserId}
                    </td>
                    <td className="px-3 py-2 font-medium text-neutral-800">
                      {order.entitlementId}
                    </td>
                    <td className="px-3 py-2">
                      <PlatformBadge tone={orderStateTone(order.state, order.tombstone)}>
                        {order.tombstone ? "초기화됨" : order.state}
                      </PlatformBadge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-neutral-500">
                      {formatPlatformTimestamp(order.observedAt ?? order.purchasedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PlatformPanel>

      <PlatformPanel
        title="사용자 Entitlement"
        description={
          selectedPlatformUserId
            ? `${selectedPlatformUserId}의 활성·비활성 entitlement와 지급 근거입니다.`
            : "플랫폼 사용자 ID를 선택하면 entitlement를 표시합니다."
        }
      >
        {entitlements.length === 0 ? (
          <PlatformEmptyState
            title={selectedPlatformUserId ? "Entitlement가 없습니다" : "사용자가 선택되지 않았습니다"}
          >
            {selectedPlatformUserId
              ? "선택한 사용자에게 기록된 entitlement가 없습니다."
              : "사용자 조회 후 활성 상태와 source를 확인할 수 있습니다."}
          </PlatformEmptyState>
        ) : (
          <div className="divide-y divide-neutral-100">
            {entitlements.map((entitlement) => (
              <div key={entitlement.entitlementId} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-sm font-medium text-neutral-800">
                      {entitlement.entitlementId}
                    </div>
                    <div className="mt-1 text-[11px] text-neutral-400">
                      갱신 {formatPlatformTimestamp(entitlement.updatedAt)}
                    </div>
                  </div>
                  <PlatformBadge tone={entitlement.active ? "green" : "neutral"}>
                    {entitlement.active ? "활성" : "비활성"}
                  </PlatformBadge>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {entitlement.sources.length === 0 ? (
                    <span className="text-xs text-neutral-400">지급 source 없음</span>
                  ) : (
                    entitlement.sources.map((source, index) => (
                      <span
                        key={`${source.market}:${source.productId}:${index}`}
                        className="rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px] text-neutral-600"
                        title={`관찰 ${formatPlatformTimestamp(source.observedAt)}`}
                      >
                        {marketLabel(source.market)} · {source.productId} · {source.state}
                      </span>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </PlatformPanel>

      <PlatformPanel
        title="운영자 지급·회수 이력"
        description="운영자, 변경 사유와 멱등 요청 ID를 함께 확인합니다."
        trailing={<span className="text-xs text-neutral-400">{operatorRecords.length}건</span>}
      >
        {operatorRecords.length === 0 ? (
          <PlatformEmptyState title="운영자 변경 이력이 없습니다">
            지급 또는 회수 작업이 완료되면 감사 이력이 표시됩니다.
          </PlatformEmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-neutral-200 text-left text-xs">
              <thead className="bg-neutral-50 text-neutral-500">
                <tr>
                  <th className="px-3 py-2 font-medium">작업</th>
                  <th className="px-3 py-2 font-medium">앱·사용자</th>
                  <th className="px-3 py-2 font-medium">Entitlement</th>
                  <th className="px-3 py-2 font-medium">운영자·사유</th>
                  <th className="px-3 py-2 font-medium">요청·시각</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {operatorRecords.map((record) => (
                  <tr key={`${record.kind}:${record.requestId}`}>
                    <td className="px-3 py-2">
                      <PlatformBadge tone={record.kind === "grant" ? "green" : "red"}>
                        {record.kind === "grant" ? "지급" : "회수"}
                      </PlatformBadge>
                    </td>
                    <td className="max-w-52 px-3 py-2 text-neutral-600">
                      <div>{record.appId}</div>
                      <div className="truncate font-mono text-[10px] text-neutral-400">
                        {record.platformUserId}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-medium text-neutral-800">
                      {record.entitlementId}
                    </td>
                    <td className="max-w-64 px-3 py-2 text-neutral-600">
                      <div>{record.actorLogin ? `@${record.actorLogin}` : "운영자 미확인"}</div>
                      <div className="truncate text-[11px] text-neutral-400">
                        {record.reason ?? "사유 미확인"}
                      </div>
                    </td>
                    <td className="max-w-52 px-3 py-2 text-neutral-500">
                      <div className="truncate font-mono text-[10px]">{record.requestId}</div>
                      {record.grantRequestId && (
                        <div className="mt-0.5 truncate font-mono text-[10px] text-neutral-400">
                          원 지급 {record.grantRequestId}
                        </div>
                      )}
                      <div className="mt-0.5 whitespace-nowrap text-[11px]">
                        {formatPlatformTimestamp(record.createdAt)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PlatformPanel>

      <PlatformPanel title="최근 쓰기 작업" description="지급·회수 요청의 완료 여부를 명시적으로 표시합니다.">
        <div
          role={writeOperation.state === "error" ? "alert" : "status"}
          className="flex flex-wrap items-start justify-between gap-3 px-4 py-4"
        >
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <PlatformBadge tone={writeView.tone}>{writeView.label}</PlatformBadge>
              {writeOperation.actionLabel && (
                <span className="text-sm font-medium text-neutral-800">
                  {writeOperation.actionLabel}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-neutral-500">
              {writeOperation.summary ?? "실행 중인 지급·회수 작업이 없습니다."}
            </p>
          </div>
          {writeOperation.requestId && (
            <span className="max-w-64 truncate font-mono text-[10px] text-neutral-400">
              {writeOperation.requestId}
            </span>
          )}
        </div>
      </PlatformPanel>
    </div>
  );
}

function marketLabel(market: string): string {
  const normalized = market.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "app_store") return "App Store";
  if (normalized === "google_play") return "Google Play";
  if (normalized === "apps_in_toss") return "AppsInToss";
  if (normalized === "operator") return "운영자";
  return market || "마켓 미확인";
}

function orderStateTone(
  state: string,
  tombstone: boolean | undefined,
): "neutral" | "green" | "amber" | "red" {
  if (tombstone) return "neutral";
  const normalized = state.trim().toLowerCase();
  if (normalized === "active" || normalized === "completed") return "green";
  if (normalized === "pending" || normalized === "processing") return "amber";
  if (normalized === "failed" || normalized === "refunded") return "red";
  return "neutral";
}
