"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";

import {
  loadPlatformAdClaimsAction,
  loadPlatformAdsConfigAction,
  loadPlatformAdsHealthAction,
  lookupPlatformUserAdsAction,
} from "@/lib/actions/platform-ads";
import {
  enqueuePlatformOperationAction,
  getPlatformOperationStatusAction,
  retryUnknownPlatformOperationAction,
} from "@/lib/actions/platform-ops";
import type {
  PlatformAdClaim,
  PlatformAdsConfig,
  PlatformAdsHealth,
  PlatformUserAds,
} from "@/lib/platform/client";
import {
  activeAdsSuppressionGrant,
  adsAssuranceLabel,
  adsConfigDriftWarning,
  adsHealthLabel,
  adsLookupState,
  adsQueueDisplay,
} from "@/lib/platform/ads-presentation";
import {
  PLATFORM_OPERATION_REASONS,
  type PlatformOperationReason,
} from "@/lib/platform/reasons";
import {
  listPlatformRecoveryReferences,
  removePlatformRecoveryReference,
  savePlatformRecoveryReference,
  type PlatformRecoveryReference,
} from "@/lib/platform/recovery";
import {
  PlatformBadge,
  PlatformEmptyState,
  PlatformMeta,
  PlatformPanel,
  formatPlatformTimestamp,
} from "./PlatformUi";
import {
  PlatformAdsBlockReasons,
  PlatformAdsLookupFeedback,
  PlatformAdsPolicyBadge,
} from "./PlatformAdsStates";

type Tab = "policy" | "claims" | "config";
export interface PlatformAdsApp {
  appId: string;
  label: string;
  localConfigSyncedAt?: string;
}
export function PlatformAdsConsole({ apps }: { apps: PlatformAdsApp[] }) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>("policy");
  const [health, setHealth] = useState<PlatformAdsHealth | null>(null);
  const [healthError, setHealthError] = useState("");
  const [pending, startTransition] = useTransition();
  const [reference, setReference] = useState("");
  const [user, setUser] = useState<PlatformUserAds | null>(null);
  const [lookupError, setLookupError] = useState("");
  const [lookupCode, setLookupCode] = useState("");
  const [lookupRequested, setLookupRequested] = useState(false);
  const [reason, setReason] = useState<PlatformOperationReason>(
    "customer_support_compensation",
  );
  const [confirmation, setConfirmation] = useState("");
  const [mutation, setMutation] = useState("");
  const [recovery, setRecovery] = useState<PlatformRecoveryReference | null>(
    null,
  );
  const [revokeAdFreeNotice, setRevokeAdFreeNotice] = useState(false);
  const [claims, setClaims] = useState<PlatformAdClaim[]>([]);
  const [claimError, setClaimError] = useState("");
  const [filters, setFilters] = useState({
    appId: "",
    provider: "",
    state: "",
    assurance: "",
    placement: "",
    reference: "",
  });
  const [selectedApp, setSelectedApp] = useState(apps[0]?.appId ?? "");
  const [config, setConfig] = useState<PlatformAdsConfig | null>(null);
  const [configError, setConfigError] = useState("");
  const activeGrant = useMemo(() => activeAdsSuppressionGrant(user), [user]);
  const operation = activeGrant
    ? ("platform.ads.revoke-suppression" as const)
    : ("platform.ads.grant-suppression" as const);
  const expected = user
    ? activeGrant
      ? `ENABLE ADS ${user.appId} ${user.platformUserId} ${activeGrant}`
      : `DISABLE ADS ${user.appId} ${user.platformUserId}`
    : "";
  const lookupState = adsLookupState({
    requested: lookupRequested,
    loading: pending,
    errorCode: lookupCode,
    user,
  });

  useEffect(() => {
    void refreshHealth();
    const initial = searchParams.get("reference");
    if (initial) setReference(initial);
    try {
      setRecovery(
        listPlatformRecoveryReferences(window.localStorage).find((x) =>
          x.operation.startsWith("platform.ads."),
        ) ?? null,
      );
    } catch {
      /* fail closed in submit */
    }
  }, [searchParams]);
  async function refreshHealth() {
    const result = await loadPlatformAdsHealthAction();
    if (result.ok) {
      setHealth(result.data);
      setHealthError("");
    } else {
      setHealth(null);
      setHealthError(result.error);
    }
  }
  function lookup() {
    setLookupRequested(true);
    setRevokeAdFreeNotice(false);
    startTransition(async () => {
      const result = await lookupPlatformUserAdsAction(reference);
      if (result.ok) {
        setUser(result.data);
        setLookupError("");
        setLookupCode("");
        setConfirmation("");
      } else {
        setUser(null);
        setLookupError(result.error);
        setLookupCode(result.code);
      }
    });
  }
  async function reloadUser() {
    if (!user) return null;
    const result = await lookupPlatformUserAdsAction(user.platformUserId);
    if (!result.ok) return null;
    setUser(result.data);
    return result.data;
  }
  function submitMutation() {
    if (!user || confirmation !== expected) return;
    setRevokeAdFreeNotice(false);
    startTransition(async () => {
      // 복구 참조에는 의도적으로 PUID를 저장하지 않는다. 따라서 같은 앱과
      // operation이라는 이유만으로 기존 request ID를 현재 조회 사용자에게
      // 재사용하면 안 된다. 복구 중에는 아래 버튼을 잠그고 전용 retry만 쓴다.
      const requestId = crypto.randomUUID();
      const ref = { requestId, appSlug: user.appId, operation };
      try {
        savePlatformRecoveryReference(window.localStorage, ref);
      } catch {
        setMutation(
          "브라우저 복구 저장소를 사용할 수 없어 요청을 시작하지 않았습니다.",
        );
        return;
      }
      setRecovery(ref);
      setMutation("대기");
      const common = {
        requestId,
        appSlug: user.appId,
        platformUserId: user.platformUserId,
        reason,
        serverConfirmation: confirmation,
      };
      const result = activeGrant
        ? await enqueuePlatformOperationAction({
            ...common,
            operation: "platform.ads.revoke-suppression",
            grantRequestId: activeGrant,
          })
        : await enqueuePlatformOperationAction({
            ...common,
            operation: "platform.ads.grant-suppression",
          });
      if (!result.ok) {
        setMutation(result.error ?? "요청 등록 실패");
        return;
      }
      setMutation("실행 중");
      await poll(ref);
    });
  }
  async function poll(ref: PlatformRecoveryReference) {
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const status = await getPlatformOperationStatusAction(
        ref.appSlug,
        ref.requestId,
      );
      const display = adsQueueDisplay(status);
      setMutation(display);
      if (display === "결과 미확인") return;
      if (display === "완료" || display === "실패") {
        try {
          removePlatformRecoveryReference(window.localStorage, ref.requestId);
        } catch {}
        setRecovery(null);
        if (display === "완료") {
          const refreshed = await reloadUser();
          setRevokeAdFreeNotice(
            ref.operation === "platform.ads.revoke-suppression" &&
              Boolean(refreshed?.policy.disabledBy.includes("ad_free")),
          );
        }
        return;
      }
    }
    setMutation("결과 미확인");
  }
  function retryUnknown() {
    if (!recovery) return;
    startTransition(async () => {
      const result = await retryUnknownPlatformOperationAction(
        recovery.appSlug,
        recovery.requestId,
      );
      if (!result.ok) {
        setMutation(
          result.error ?? "결과 미확인 요청을 재실행하지 못했습니다.",
        );
        return;
      }
      setMutation("대기");
      await poll(recovery);
    });
  }
  function loadClaims() {
    startTransition(async () => {
      const result = await loadPlatformAdClaimsAction(filters);
      if (result.ok) {
        setClaims(result.data);
        setClaimError("");
      } else setClaimError(result.error);
    });
  }
  function loadConfig(appId = selectedApp) {
    if (!appId) return;
    startTransition(async () => {
      const result = await loadPlatformAdsConfigAction(appId);
      if (result.ok) {
        setConfig(result.data);
        setConfigError("");
      } else {
        setConfig(null);
        setConfigError(result.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-5">
        {[
          ["Ads 서비스", adsHealthLabel(health)],
          ["최근 SSV 성공", formatPlatformTimestamp(health?.lastSsvSuccessAt)],
          ["Invalid signature", health?.invalidSignatureCount ?? "—"],
          ["오래된 pending", health?.stalePendingClaimCount ?? "—"],
          ["Policy 조회 실패", health?.policyFailureCount ?? "—"],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className="rounded-lg border border-neutral-200 bg-white p-3"
          >
            <div className="text-[11px] text-neutral-500">{label}</div>
            <div className="mt-1 text-sm font-semibold text-neutral-800">
              {value}
            </div>
          </div>
        ))}
      </section>
      {healthError && (
        <div
          role="alert"
          className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          확인 실패 — {healthError}
        </div>
      )}
      <div className="flex gap-1 rounded-lg bg-neutral-100 p-1">
        {(
          [
            ["policy", "사용자 광고 정책"],
            ["claims", "보상 Claim"],
            ["config", "앱 설정"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-2 text-sm ${tab === id ? "bg-white font-semibold text-neutral-900" : "text-neutral-600"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "policy" && (
        <div className="space-y-4">
          <PlatformPanel
            title="사용자 광고 정책"
            description="정확한 supportCode 또는 PUID만 조회합니다."
          >
            <div className="flex gap-2 p-4">
              <input
                aria-label="지원 코드 또는 PUID"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2 text-sm"
                placeholder="지원 코드 또는 PUID"
              />
              <button
                disabled={pending}
                onClick={lookup}
                className="rounded bg-neutral-900 px-4 py-2 text-sm text-white"
              >
                조회
              </button>
            </div>
            <PlatformAdsLookupFeedback
              state={lookupState}
              error={lookupError}
            />
            {recovery && !mutation && (
              <div className="flex items-center gap-2 border-t border-neutral-100 px-4 py-3 text-xs text-amber-700">
                <span>
                  복구할 광고 정책 요청이 있습니다: {recovery.requestId}
                </span>
                <button
                  disabled={pending}
                  onClick={() => void poll(recovery)}
                  className="rounded border border-amber-300 px-2 py-1"
                >
                  상태 확인
                </button>
              </div>
            )}
          </PlatformPanel>
          {user && (
            <PlatformPanel
              title={`${user.supportCode} 광고 상태`}
              trailing={<PlatformAdsPolicyBadge policy={user.policy} />}
            >
              <div className="grid gap-5 p-4 md:grid-cols-2">
                <dl>
                  <PlatformMeta label="앱" value={user.appId} />
                  <PlatformMeta label="PUID" value={user.platformUserId} mono />
                  <PlatformMeta
                    label="지원 코드"
                    value={user.supportCode}
                    mono
                  />
                  <PlatformMeta label="인증 유형" value={user.authType} />
                  <PlatformMeta
                    label="최근 확인"
                    value={formatPlatformTimestamp(user.lastSeenAt)}
                  />
                  <PlatformMeta
                    label="차단 원인"
                    value={
                      <PlatformAdsBlockReasons
                        reasons={user.policy.disabledBy}
                      />
                    }
                  />
                </dl>
                {user.policy.appUsesAds && (
                  <div className="space-y-3">
                    <div className="text-sm font-semibold">
                      {activeGrant
                        ? "운영자 광고 차단 회수"
                        : "운영자 광고 차단 추가"}
                    </div>
                    <select
                      value={reason}
                      onChange={(e) =>
                        setReason(e.target.value as PlatformOperationReason)
                      }
                      className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
                    >
                      {PLATFORM_OPERATION_REASONS.map((x) => (
                        <option key={x.code} value={x.code}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                    <div className="rounded bg-neutral-50 p-2 font-mono text-xs">
                      {expected}
                    </div>
                    <input
                      aria-label="typed confirmation"
                      value={confirmation}
                      onChange={(e) => setConfirmation(e.target.value)}
                      className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
                    />
                    <button
                      disabled={
                        pending ||
                        confirmation !== expected ||
                        Boolean(recovery)
                      }
                      onClick={submitMutation}
                      className="rounded bg-red-700 px-4 py-2 text-sm text-white disabled:opacity-40"
                    >
                      {activeGrant
                        ? "운영자 광고 차단 회수"
                        : "운영자 광고 차단 추가"}
                    </button>
                    {mutation && (
                      <p role="status" className="text-sm text-neutral-600">
                        {mutation}
                        {recovery ? ` · ${recovery.requestId}` : ""}
                      </p>
                    )}
                    {recovery && mutation === "결과 미확인" && (
                      <button
                        disabled={pending}
                        onClick={retryUnknown}
                        className="rounded border border-neutral-300 px-3 py-2 text-sm"
                      >
                        같은 request ID로 재조회·재실행
                      </button>
                    )}
                    {revokeAdFreeNotice && (
                      <p className="text-sm text-amber-700">
                        운영자 차단은 회수됐지만 구매 권한으로 계속 차단됨
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="border-t border-neutral-100 px-4 py-3">
                <div className="text-xs font-semibold text-neutral-600">
                  감사 이력
                </div>
                {user.auditHistory.length === 0 ? (
                  <p className="mt-2 text-xs text-neutral-400">
                    이력이 없습니다.
                  </p>
                ) : (
                  user.auditHistory.map((x) => (
                    <div
                      key={`${x.operation}:${x.requestId}`}
                      className="mt-2 flex justify-between text-xs"
                    >
                      <span>
                        {x.operation === "grant" ? "차단 추가" : "차단 회수"} ·{" "}
                        {x.reason}
                      </span>
                      <span>{formatPlatformTimestamp(x.createdAt)}</span>
                    </div>
                  ))
                )}
              </div>
            </PlatformPanel>
          )}
        </div>
      )}
      {tab === "claims" && (
        <PlatformPanel
          title="보상 Claim"
          description="수동 지급과 강제 verified 전환은 제공하지 않습니다."
        >
          <div className="grid gap-2 p-4 sm:grid-cols-3">
            {Object.keys(filters).map((key) => (
              <input
                key={key}
                aria-label={key}
                value={filters[key as keyof typeof filters]}
                onChange={(e) =>
                  setFilters({ ...filters, [key]: e.target.value })
                }
                placeholder={key}
                className="rounded border border-neutral-300 px-3 py-2 text-sm"
              />
            ))}
            <button
              onClick={loadClaims}
              className="rounded bg-neutral-900 px-4 py-2 text-sm text-white"
            >
              조회
            </button>
          </div>
          {claimError && (
            <p className="px-4 pb-3 text-sm text-red-600">{claimError}</p>
          )}
          {claims.length === 0 ? (
            <PlatformEmptyState title="표시할 Claim이 없습니다">
              필터를 입력하고 조회하세요.
            </PlatformEmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-neutral-50">
                  <tr>
                    {[
                      "Claim",
                      "앱·지면",
                      "Provider",
                      "Reward",
                      "상태",
                      "Assurance",
                      "생성·확인·Ack",
                    ].map((x) => (
                      <th key={x} className="px-3 py-2">
                        {x}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {claims.map((c) => (
                    <tr key={c.claimId} className="border-t">
                      <td className="px-3 py-2 font-mono">{c.claimId}</td>
                      <td className="px-3 py-2">
                        {c.appId}
                        <br />
                        {c.placement}
                      </td>
                      <td className="px-3 py-2">{c.provider}</td>
                      <td className="px-3 py-2">
                        {c.reward.key} × {c.reward.amount}
                      </td>
                      <td className="px-3 py-2">{c.state}</td>
                      <td className="px-3 py-2">
                        <PlatformBadge
                          tone={
                            c.assurance === "server_verified"
                              ? "green"
                              : c.assurance === "client_confirmed"
                                ? "amber"
                                : "neutral"
                          }
                        >
                          {adsAssuranceLabel(c.assurance)}
                        </PlatformBadge>
                      </td>
                      <td className="px-3 py-2">
                        {formatPlatformTimestamp(c.createdAt)}
                        <br />
                        {formatPlatformTimestamp(c.confirmedAt)}
                        <br />
                        {formatPlatformTimestamp(c.acknowledgedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PlatformPanel>
      )}
      {tab === "config" && (
        <PlatformPanel
          title="앱 설정"
          description="registry/apps/*.json과 regsync가 source of truth입니다."
        >
          <div className="flex gap-2 p-4">
            <select
              value={selectedApp}
              onChange={(e) => setSelectedApp(e.target.value)}
              className="rounded border border-neutral-300 px-3 py-2 text-sm"
            >
              {apps.map((x) => (
                <option key={x.appId} value={x.appId}>
                  {x.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => loadConfig()}
              className="rounded bg-neutral-900 px-4 py-2 text-sm text-white"
            >
              설정 조회
            </button>
          </div>
          {configError && (
            <p className="px-4 pb-3 text-sm text-red-600">{configError}</p>
          )}
          {config && (
            <div className="space-y-3 p-4 pt-0">
              <div className="text-xs text-neutral-500">
                Provider: {config.providers.join(", ")} · registry sync:{" "}
                {formatPlatformTimestamp(config.registrySyncedAt)}
              </div>
              {adsConfigDriftWarning(
                config.registrySyncedAt,
                apps.find((app) => app.appId === config.appId)
                  ?.localConfigSyncedAt,
              ) && (
                <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                  {adsConfigDriftWarning(
                    config.registrySyncedAt,
                    apps.find((app) => app.appId === config.appId)
                      ?.localConfigSyncedAt,
                  )}
                </p>
              )}
              {config.placements.map((p) => (
                <div
                  key={p.id}
                  className="rounded border border-neutral-200 p-3 text-xs"
                >
                  <div className="font-semibold">
                    {p.id} · {p.format}
                  </div>
                  <div className="mt-1 text-neutral-600">
                    일일 {p.dailyLimit}회 · cooldown {p.cooldownSeconds}초
                  </div>
                  <div className="mt-1 font-mono text-neutral-500">
                    {Object.entries(p.providers)
                      .map(
                        ([name, v]) =>
                          `${name}: ${v.androidAdUnitSuffix ?? v.iosAdUnitSuffix ?? v.adGroupSuffix ?? "—"}`,
                      )
                      .join(" / ")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </PlatformPanel>
      )}
    </div>
  );
}
