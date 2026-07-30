"use client";

import { useCallback, useEffect, useState } from "react";

import { AppOperationHistory } from "@/components/app-ops/AppOperationControls";
import {
  dispatchAppOperationAction,
  getAppOperationStatusAction,
} from "@/lib/actions/app-ops";
import type { AppOpsTool } from "@/lib/app-ops/manifest";
import type { AppOpsResult } from "@/lib/app-ops/operation";
import {
  LIZARD_ENTITLEMENTS,
  lizardEntitlementLabel,
  parseLizardOperatorGrants,
  parseLizardPurchases,
  parseLizardSandboxTesters,
  type LizardOperatorGrant,
  type LizardPurchase,
  type LizardSandboxTester,
} from "@/lib/app-ops/lizard-tycoon-view";

const POLL_LIMIT = 60;
const POLL_INTERVAL_MS = 1_000;

type RowAction =
  | { kind: "sandbox-reset"; purchase: LizardPurchase }
  | { kind: "grant-revoke"; grant: LizardOperatorGrant };

export function LizardTycoonIapConsole({
  appId,
  tool,
}: {
  appId: string;
  tool: AppOpsTool;
}) {
  const [purchases, setPurchases] = useState<LizardPurchase[]>([]);
  const [testers, setTesters] = useState<LizardSandboxTester[]>([]);
  const [grants, setGrants] = useState<LizardOperatorGrant[]>([]);
  const [sandboxTesterId, setSandboxTesterId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [rowAction, setRowAction] = useState<RowAction | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [actionConfirmation, setActionConfirmation] = useState("");
  const [playerRef, setPlayerRef] = useState("");
  const [entitlementId, setEntitlementId] = useState<string>(
    LIZARD_ENTITLEMENTS[0].value,
  );
  const [grantReason, setGrantReason] = useState("");
  const [grantConfirmation, setGrantConfirmation] = useState("");

  const operationLabel = useCallback(
    (operationId: string) => {
      const operation = tool.operations.find(
        (candidate) => candidate.id === operationId,
      );
      if (!operation) {
        throw new Error(`manifest operation이 없습니다: ${operationId}`);
      }
      return operation.label;
    },
    [tool.operations],
  );

  const execute = useCallback(
    async (
      operationId: string,
      values: Record<string, string | number | boolean>,
      reason = "",
      confirmationText = "",
    ): Promise<AppOpsResult> => {
      const dispatched = await dispatchAppOperationAction({
        appId,
        toolId: tool.id,
        operationId,
        values,
        reason,
        confirmationText,
      });
      if (!dispatched.ok || !dispatched.requestId) {
        throw new Error(dispatched.error ?? "실행 요청에 실패했습니다.");
      }
      for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
        const response = await getAppOperationStatusAction(
          appId,
          dispatched.requestId,
        );
        if (!response.ok) {
          throw new Error(response.error ?? "실행 상태를 읽지 못했습니다.");
        }
        if (response.status === "completed") {
          if (!response.result || response.result.status !== "success") {
            throw new Error(
              response.resultError ??
                response.result?.summary ??
                "worker 실행에 실패했습니다.",
            );
          }
          return response.result;
        }
        await new Promise((resolve) =>
          window.setTimeout(resolve, POLL_INTERVAL_MS),
        );
      }
      throw new Error("자동 확인 시간이 끝났습니다. 최근 실행을 확인하세요.");
    },
    [appId, tool.id],
  );

  const refresh = useCallback(async (announce = true) => {
    setLoading(true);
    try {
      const [purchaseResult, testerResult, grantResult] = await Promise.all([
        execute("recent-purchases", { environment: "sandbox", limit: 20 }),
        execute("sandbox-testers", {}),
        execute("production-grants", { limit: 20 }),
      ]);
      const nextPurchases = parseLizardPurchases(purchaseResult.data);
      const nextTesters = parseLizardSandboxTesters(testerResult.data);
      const nextGrants = parseLizardOperatorGrants(grantResult.data);
      setPurchases(nextPurchases);
      setTesters(nextTesters);
      setGrants(nextGrants);
      setSandboxTesterId((current) =>
        nextTesters.some((tester) => tester.sandboxTesterId === current)
          ? current
          : (nextTesters[0]?.sandboxTesterId ?? ""),
      );
      if (announce) {
        setFeedback({
          ok: true,
          message: `최근 구매 ${nextPurchases.length}건 · Sandbox 계정 ${nextTesters.length}개 · 운영자 지급 ${nextGrants.length}건`,
        });
      }
    } catch (error) {
      setFeedback({ ok: false, message: (error as Error).message });
    } finally {
      setLoading(false);
    }
  }, [execute]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  function closeRowAction() {
    setRowAction(null);
    setActionReason("");
    setActionConfirmation("");
  }

  async function submitRowAction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rowAction) return;
    setBusy(true);
    setFeedback(null);
    try {
      if (rowAction.kind === "sandbox-reset") {
        const accountRef = rowAction.purchase.testAccountRef;
        if (!accountRef || !sandboxTesterId) {
          throw new Error("Firebase UID와 Apple Sandbox 계정을 선택해야 합니다.");
        }
        const result = await execute(
          "reset-app-store-sandbox",
          {
            environment: "sandbox",
            test_account_ref: accountRef,
            sandbox_tester_id: sandboxTesterId,
          },
          actionReason,
          actionConfirmation,
        );
        setFeedback({ ok: true, message: result.summary });
      } else {
        const result = await execute(
          "revoke-production-entitlement",
          { grant_ref: rowAction.grant.grantRef },
          actionReason,
          actionConfirmation,
        );
        setFeedback({ ok: true, message: result.summary });
      }
      closeRowAction();
      await refresh(false);
    } catch (error) {
      setFeedback({ ok: false, message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function submitGrant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const result = await execute(
        "grant-production-entitlement",
        {
          player_ref: playerRef,
          entitlement_id: entitlementId,
        },
        grantReason,
        grantConfirmation,
      );
      setFeedback({ ok: true, message: result.summary });
      setPlayerRef("");
      setGrantReason("");
      setGrantConfirmation("");
      await refresh(false);
    } catch (error) {
      setFeedback({ ok: false, message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const selectedTester = testers.find(
    (tester) => tester.sandboxTesterId === sandboxTesterId,
  );

  return (
    <>
      <div className="space-y-6">
        <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-neutral-200 px-4 py-3">
            <div>
              <h3 className="font-semibold text-neutral-900">
                Sandbox 최근 구매
              </h3>
              <p className="mt-1 text-xs text-neutral-500">
                Apple 행에서 구매내역 초기화와 Firebase 지급 회수를 한 번에
                실행합니다.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-neutral-600">
                <span className="mb-1 block font-medium">
                  현재 iPhone의 Sandbox Apple 계정
                </span>
                <select
                  value={sandboxTesterId}
                  onChange={(event) => setSandboxTesterId(event.target.value)}
                  disabled={loading || busy}
                  className="min-w-64 rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
                >
                  <option value="">계정 선택</option>
                  {testers.map((tester) => (
                    <option
                      key={tester.sandboxTesterId}
                      value={tester.sandboxTesterId}
                    >
                      {tester.accountName ??
                        (`${tester.firstName ?? ""} ${tester.lastName ?? ""}`.trim() ||
                          tester.sandboxTesterId)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void refresh(true)}
                disabled={loading || busy}
                className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
              >
                {loading ? "불러오는 중…" : "새로고침"}
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-neutral-200 text-left text-xs">
              <thead className="bg-neutral-50 text-neutral-500">
                <tr>
                  <th className="px-4 py-2 font-medium">도마뱀</th>
                  <th className="px-4 py-2 font-medium">마켓</th>
                  <th className="px-4 py-2 font-medium">Firebase UID</th>
                  <th className="px-4 py-2 font-medium">상태</th>
                  <th className="px-4 py-2 font-medium">구매·갱신 시각</th>
                  <th className="px-4 py-2 text-right font-medium">작업</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {purchases.map((purchase) => {
                  const resettable =
                    purchase.platform === "app_store" &&
                    Boolean(purchase.testAccountRef) &&
                    ["active", "pending"].includes(purchase.state ?? "");
                  return (
                    <tr key={purchase.purchaseRef}>
                      <td className="px-4 py-3 font-medium text-neutral-800">
                        {lizardEntitlementLabel(purchase.entitlementId)}
                        <div className="mt-0.5 font-mono text-[10px] font-normal text-neutral-400">
                          {purchase.productId}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-neutral-600">
                        {purchase.platform === "app_store"
                          ? "App Store"
                          : purchase.platform === "google_play"
                            ? "Google Play"
                            : (purchase.platform ?? "—")}
                      </td>
                      <td className="max-w-56 truncate px-4 py-3 font-mono text-[11px] text-neutral-600">
                        {purchase.testAccountRef ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <StateBadge state={purchase.state} />
                      </td>
                      <td className="px-4 py-3 text-neutral-500">
                        {formatDate(
                          purchase.purchasedAt ?? purchase.updatedAt,
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {resettable ? (
                          <button
                            type="button"
                            disabled={!sandboxTesterId || busy}
                            onClick={() =>
                              setRowAction({
                                kind: "sandbox-reset",
                                purchase,
                              })
                            }
                            className="rounded bg-amber-600 px-2.5 py-1.5 font-medium text-white hover:bg-amber-500 disabled:opacity-40"
                          >
                            재구매 초기화
                          </button>
                        ) : (
                          <span className="text-neutral-400">
                            {purchase.platform === "google_play"
                              ? "Play Console에서 처리"
                              : "작업 없음"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!loading && purchases.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-neutral-400"
                    >
                      Sandbox 구매 내역이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-amber-100 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
            Apple 초기화는 선택한 Sandbox Apple 계정의 모든 테스트 구매·구독
            내역을 지웁니다. 실제 고객 구매와 Production 원장은 건드리지
            않습니다.
          </div>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <div>
            <h3 className="font-semibold text-neutral-900">
              Production 운영자 지급
            </h3>
            <p className="mt-1 text-xs text-neutral-500">
              Firebase UID에 도마뱀을 직접 지급합니다. 운영자, 사유, 지급·회수
              시각은 Production 감사 원장에 남습니다.
            </p>
          </div>
          <form
            onSubmit={submitGrant}
            className="mt-4 grid gap-3 rounded-lg bg-neutral-50 p-3 lg:grid-cols-2"
          >
            <label className="text-xs text-neutral-600">
              <span className="mb-1 block font-medium">Firebase UID*</span>
              <input
                value={playerRef}
                onChange={(event) => setPlayerRef(event.target.value)}
                required
                disabled={busy}
                className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-neutral-600">
              <span className="mb-1 block font-medium">지급 도마뱀*</span>
              <select
                value={entitlementId}
                onChange={(event) => setEntitlementId(event.target.value)}
                disabled={busy}
                className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
              >
                {LIZARD_ENTITLEMENTS.map((entitlement) => (
                  <option key={entitlement.value} value={entitlement.value}>
                    {entitlement.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-600">
              <span className="mb-1 block font-medium">지급 사유*</span>
              <textarea
                value={grantReason}
                onChange={(event) => setGrantReason(event.target.value)}
                required
                maxLength={500}
                disabled={busy}
                className="min-h-16 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-neutral-600">
              <span className="mb-1 block font-medium">
                확인 문구 “
                {operationLabel("grant-production-entitlement")}
                ”*
              </span>
              <input
                value={grantConfirmation}
                onChange={(event) => setGrantConfirmation(event.target.value)}
                required
                disabled={busy}
                className="w-full rounded border border-red-200 bg-white px-2 py-1.5 text-sm"
              />
            </label>
            <div className="lg:col-span-2">
              <button
                type="submit"
                disabled={busy}
                className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
              >
                {busy ? "처리 중…" : "Production 지급"}
              </button>
            </div>
          </form>

          <div className="mt-4 overflow-x-auto rounded border border-neutral-200">
            <table className="min-w-full divide-y divide-neutral-200 text-left text-xs">
              <thead className="bg-neutral-50 text-neutral-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Firebase UID</th>
                  <th className="px-3 py-2 font-medium">도마뱀</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                  <th className="px-3 py-2 font-medium">운영자·사유</th>
                  <th className="px-3 py-2 font-medium">갱신 시각</th>
                  <th className="px-3 py-2 text-right font-medium">작업</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {grants.map((grant) => (
                  <tr key={grant.grantRef}>
                    <td className="max-w-56 truncate px-3 py-2 font-mono text-[11px] text-neutral-600">
                      {grant.playerRef ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-medium text-neutral-800">
                      {lizardEntitlementLabel(grant.entitlementId)}
                    </td>
                    <td className="px-3 py-2">
                      <StateBadge state={grant.state} />
                    </td>
                    <td className="max-w-64 px-3 py-2 text-neutral-600">
                      <div>{grant.actorLogin ?? "—"}</div>
                      <div className="truncate text-[11px] text-neutral-400">
                        {grant.reason ?? "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-neutral-500">
                      {formatDate(grant.updatedAt)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {grant.state === "active" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            setRowAction({ kind: "grant-revoke", grant })
                          }
                          className="rounded border border-red-200 px-2.5 py-1 text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          지급 회수
                        </button>
                      ) : (
                        <span className="text-neutral-400">회수 완료</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!loading && grants.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-6 text-center text-neutral-400"
                    >
                      운영자 지급 내역이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {feedback && (
          <div
            className={`rounded-lg border px-4 py-3 text-sm ${
              feedback.ok
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {feedback.message}
          </div>
        )}
      </div>

      <AppOperationHistory appId={appId} />

      {rowAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={submitRowAction}
            className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl"
          >
            <h3 className="font-semibold text-neutral-900">
              {rowAction.kind === "sandbox-reset"
                ? "Sandbox 재구매 초기화"
                : "Production 지급 회수"}
            </h3>
            {rowAction.kind === "sandbox-reset" ? (
              <div className="mt-2 rounded bg-amber-50 p-3 text-xs text-amber-900">
                <div>
                  Apple 계정:{" "}
                  <strong>
                    {selectedTester?.accountName ?? sandboxTesterId}
                  </strong>
                </div>
                <div className="mt-1">
                  Firebase UID:{" "}
                  <span className="font-mono">
                    {rowAction.purchase.testAccountRef}
                  </span>
                </div>
                <p className="mt-2">
                  선택한 Apple 계정의 모든 Sandbox 구매내역을 지운 뒤 이 UID의
                  App Store 지급을 회수합니다.
                </p>
              </div>
            ) : (
              <div className="mt-2 rounded bg-red-50 p-3 text-xs text-red-800">
                {rowAction.grant.playerRef} 계정의{" "}
                {lizardEntitlementLabel(rowAction.grant.entitlementId)} 운영자
                지급을 회수합니다. 유료 구매 source가 남아 있으면 보유 상태는
                유지됩니다.
              </div>
            )}
            <label className="mt-3 block text-xs text-neutral-600">
              <span className="mb-1 block font-medium">변경 사유*</span>
              <textarea
                value={actionReason}
                onChange={(event) => setActionReason(event.target.value)}
                required
                maxLength={500}
                disabled={busy}
                className="min-h-20 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="mt-3 block text-xs text-neutral-600">
              <span className="mb-1 block font-medium">
                확인 문구 “
                {operationLabel(
                  rowAction.kind === "sandbox-reset"
                    ? "reset-app-store-sandbox"
                    : "revoke-production-entitlement",
                )}
                ”*
              </span>
              <input
                value={actionConfirmation}
                onChange={(event) =>
                  setActionConfirmation(event.target.value)
                }
                required
                disabled={busy}
                className="w-full rounded border border-red-200 px-2 py-1.5 text-sm"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeRowAction}
                disabled={busy}
                className="rounded border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700"
              >
                취소
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {busy ? "처리 중…" : "확인 후 실행"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function StateBadge({ state }: { state: string | null }) {
  const style =
    state === "active"
      ? "bg-emerald-50 text-emerald-700"
      : state === "pending"
        ? "bg-amber-50 text-amber-700"
        : "bg-neutral-100 text-neutral-500";
  const label =
    state === "active"
      ? "보유"
      : state === "pending"
        ? "대기"
        : state === "revoked"
          ? "회수"
          : (state ?? "알 수 없음");
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${style}`}>
      {label}
    </span>
  );
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("ko-KR") : "—";
}
