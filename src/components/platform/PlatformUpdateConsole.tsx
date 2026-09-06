"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";

import {
  loadUpdatePolicyAction,
  saveUpdatePolicyAction,
} from "@/lib/actions/platform-updates";
import { savePlatformRecoveryReference } from "@/lib/platform/recovery";
import type { UpdateBlastRadius } from "@/lib/platform/update-guard";
import {
  PLATFORM_UPDATE_POLICY_REASONS,
  UPDATE_POLICY_PLATFORMS,
  compareVersionsDesc,
  sameVersion,
  type PlatformUpdatePolicyReason,
  type UpdatePolicyPlatform,
  type UpdatePolicyPlatformInput,
  type UpdatePolicyView,
} from "@/lib/platform/update-policy";

import {
  PlatformBadge,
  PlatformEmptyState,
  PlatformPanel,
  formatPlatformCount,
  formatPlatformTimestamp,
} from "./PlatformUi";

export interface PlatformUpdateConsoleApp {
  appId: string;
  label: string;
}

export interface PlatformUpdateConsoleProps {
  apps: readonly PlatformUpdateConsoleApp[];
  writesEnabled: boolean;
}

interface PlatformDraft {
  enabled: boolean;
  blockedVersions: string[];
  recommendOverride: string;
}

type Drafts = Record<UpdatePolicyPlatform, PlatformDraft>;

const EMPTY_DRAFTS: Drafts = {
  android: { enabled: false, blockedVersions: [], recommendOverride: "" },
  ios: { enabled: false, blockedVersions: [], recommendOverride: "" },
};

/** 서버 응답을 편집 가능한 초안으로 옮긴다. */
export function draftsFromPolicy(policy: UpdatePolicyView | null): Drafts {
  if (!policy) return EMPTY_DRAFTS;
  const out: Drafts = {
    android: { ...EMPTY_DRAFTS.android },
    ios: { ...EMPTY_DRAFTS.ios },
  };
  for (const platform of UPDATE_POLICY_PLATFORMS) {
    const view = policy.platforms[platform];
    if (!view) continue;
    out[platform] = {
      // 정책 항목이 있어야 서버가 판정한다. 없으면 그 플랫폼은 아무 일도
      // 일어나지 않는다.
      enabled: view.blockedVersions.length > 0 || view.recommendOverride !== undefined,
      blockedVersions: view.blockedVersions.map((item) => item.version),
      recommendOverride: view.recommendOverride ?? "",
    };
  }
  return out;
}

/** 플랫폼별 관측 버전 후보. 자유 입력을 두지 않는 이유가 이것이다. */
export function candidateVersions(
  policy: UpdatePolicyView | null,
  platform: UpdatePolicyPlatform,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const observed of policy?.observedVersions ?? []) {
    if (observed.platform !== platform) continue;
    const key = observed.version.replace(/^v/i, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(observed.version);
  }
  return out.sort(compareVersionsDesc);
}

function toInputs(drafts: Drafts): UpdatePolicyPlatformInput[] {
  return UPDATE_POLICY_PLATFORMS.filter((platform) => drafts[platform].enabled).map(
    (platform) => ({
      platform,
      blockedVersions: drafts[platform].blockedVersions,
      recommendOverride: drafts[platform].recommendOverride,
    }),
  );
}

/**
 * 업데이트 유도 정책 콘솔.
 *
 * 화면 순서가 곧 운영 원칙이다. 권장이 먼저 오고 강제는 접힌 채 아래에 있다.
 * 강제는 예외 경로이고, 정상 상태는 목록이 비어 있는 것이다.
 */
export function PlatformUpdateConsole({
  apps,
  writesEnabled,
}: PlatformUpdateConsoleProps) {
  const [appId, setAppId] = useState(apps[0]?.appId ?? "");
  const [policy, setPolicy] = useState<UpdatePolicyView | null>(null);
  const [drafts, setDrafts] = useState<Drafts>(EMPTY_DRAFTS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] =
    useState<PlatformUpdatePolicyReason>("new_release_rollout");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [blastRadius, setBlastRadius] = useState<UpdateBlastRadius | null>(null);
  const [showBlocked, setShowBlocked] = useState(false);

  const refresh = useCallback(async (target: string) => {
    if (!target) return;
    const result = await loadUpdatePolicyAction(target);
    if (!result.ok || !result.policy) {
      setPolicy(null);
      setDrafts(EMPTY_DRAFTS);
      setLoadError(result.error ?? "업데이트 정책을 읽지 못했습니다.");
      return;
    }
    setPolicy(result.policy);
    setDrafts(draftsFromPolicy(result.policy));
    setLoadError(null);
  }, []);

  useEffect(() => {
    void refresh(appId);
  }, [appId, refresh]);

  const inputs = useMemo(() => toInputs(drafts), [drafts]);
  const blockedCount = inputs.reduce(
    (total, entry) => total + entry.blockedVersions.length,
    0,
  );

  async function submit() {
    if (!writesEnabled || submitting) return;
    setSubmitting(true);
    setNotice(null);
    try {
      // 브라우저가 먼저 ID를 만들고 저장한 뒤에만 요청을 보낸다. 응답이
      // 유실돼도 같은 ID로 상태를 확인할 수 있어야 한다.
      const requestId = crypto.randomUUID();
      try {
        savePlatformRecoveryReference(window.localStorage, {
          requestId,
          appSlug: appId,
          operation: "platform.config.set-update-policy",
        });
      } catch {
        // 저장이 막힌 브라우저에서도 요청은 보낸다. 복구만 어려워진다.
      }

      const result = await saveUpdatePolicyAction({
        requestId,
        appSlug: appId,
        platforms: inputs,
        reason,
      });
      setBlastRadius(result.blastRadius ?? null);
      setNotice(
        result.ok
          ? `요청을 등록했습니다. request ID ${result.requestId}`
          : (result.error ?? "정책 변경을 등록하지 못했습니다."),
      );
      if (result.ok) await refresh(appId);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PlatformPanel
      title="업데이트 유도 정책"
      description="권장 안내가 기본이고, 강제는 문제 버전을 지목할 때만 씁니다."
      trailing={
        writesEnabled ? (
          <PlatformBadge tone="blue">변경 가능</PlatformBadge>
        ) : (
          <PlatformBadge tone="neutral">읽기 전용</PlatformBadge>
        )
      }
    >
      <div className="space-y-4 p-4">
        <label className="block text-xs text-neutral-500">
          앱
          <select
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
            className="mt-1 block w-full rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-900"
          >
            {apps.map((app) => (
              <option key={app.appId} value={app.appId}>
                {app.label} ({app.appId})
              </option>
            ))}
          </select>
        </label>

        {loadError ? (
          <PlatformEmptyState title="정책을 읽지 못했습니다">{loadError}</PlatformEmptyState>
        ) : (
          <>
            {UPDATE_POLICY_PLATFORMS.map((platform) => (
              <PlatformSection
                key={platform}
                platform={platform}
                policy={policy}
                draft={drafts[platform]}
                showBlocked={showBlocked}
                onChange={(next) =>
                  setDrafts((prev) => ({ ...prev, [platform]: next }))
                }
              />
            ))}

            <button
              type="button"
              onClick={() => setShowBlocked((prev) => !prev)}
              className="text-xs font-medium text-neutral-500 underline"
            >
              {showBlocked ? "강제 대상 접기" : `강제 대상 열기 (${blockedCount}건)`}
            </button>

            {blastRadius && <BlastRadiusView radius={blastRadius} />}

            <div className="flex flex-wrap items-end gap-3 border-t border-neutral-100 pt-4">
              <label className="block text-xs text-neutral-500">
                변경 사유
                <select
                  value={reason}
                  onChange={(event) =>
                    setReason(event.target.value as PlatformUpdatePolicyReason)
                  }
                  className="mt-1 block rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-900"
                >
                  {PLATFORM_UPDATE_POLICY_REASONS.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!writesEnabled || submitting}
                onClick={() => void submit()}
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:bg-neutral-300"
              >
                {submitting ? "등록 중" : "정책 저장"}
              </button>
            </div>

            {notice && (
              <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
                {notice}
              </p>
            )}
          </>
        )}
      </div>

      <div className="border-t border-neutral-100 px-4 py-3 text-[11px] leading-4 text-neutral-500">
        저장 요청은 큐를 거쳐 실행됩니다. <strong>강제 대상을 새로 추가할 때만</strong>{" "}
        확인 문구와 서버 관측 가드가 걸리고, <strong>해제에는 아무 가드도 없습니다</strong> —
        되돌리기는 언제나 즉시 가능해야 합니다. 관측되지 않은 버전, 유저가 올라갈 곳이
        없는 목록, 관측된 모든 버전을 덮는 목록은 서버가 거부합니다.
      </div>
    </PlatformPanel>
  );
}

function PlatformSection({
  platform,
  policy,
  draft,
  showBlocked,
  onChange,
}: {
  platform: UpdatePolicyPlatform;
  policy: UpdatePolicyView | null;
  draft: PlatformDraft;
  showBlocked: boolean;
  onChange: (next: PlatformDraft) => void;
}) {
  const view = policy?.platforms[platform];
  const candidates = candidateVersions(policy, platform);
  const effective = draft.recommendOverride || view?.autoRecommendedVersion || "";

  return (
    <section className="rounded-lg border border-neutral-200 p-3">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
          {platform}
        </label>
        {view?.updateUrl ? (
          <PlatformBadge tone="green">스토어 주소 있음</PlatformBadge>
        ) : (
          <PlatformBadge tone="amber">스토어 주소 없음</PlatformBadge>
        )}
      </div>

      {!draft.enabled ? (
        <p className="mt-2 text-[11px] text-neutral-500">
          꺼져 있으면 이 플랫폼에는 아무 안내도 뜨지 않습니다.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <div className="text-xs font-medium text-neutral-700">권장 기준</div>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              비워 두면 관측된 최신 안정 버전을 자동으로 따라갑니다. 릴리스마다 손댈
              필요가 없습니다.
            </p>
            <select
              value={draft.recommendOverride}
              onChange={(event) =>
                onChange({ ...draft, recommendOverride: event.target.value })
              }
              className="mt-1 block rounded-md border border-neutral-200 px-3 py-1.5 text-sm"
            >
              <option value="">자동 추종{view?.autoRecommendedVersion ? ` (${view.autoRecommendedVersion})` : ""}</option>
              {candidates.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
            <div className="mt-1 text-[11px] text-neutral-500">
              적용될 값 {effective || "없음"}
            </div>
          </div>

          {showBlocked && (
            <div>
              <div className="text-xs font-medium text-red-700">강제 대상</div>
              <p className="mt-0.5 text-[11px] text-neutral-500">
                여기 적힌 버전만 막힙니다. 관측된 빌드 중에서만 고를 수 있습니다.
              </p>
              {candidates.length === 0 ? (
                <p className="mt-1 text-[11px] text-neutral-500">
                  관측된 빌드가 없습니다.
                </p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {candidates.map((version) => {
                    const checked = draft.blockedVersions.some((item) =>
                      sameVersion(item, version),
                    );
                    const blockedAt = view?.blockedVersions.find((item) =>
                      sameVersion(item.version, version),
                    )?.blockedAt;
                    return (
                      <li key={version} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) =>
                            onChange({
                              ...draft,
                              blockedVersions: event.target.checked
                                ? [...draft.blockedVersions, version]
                                : draft.blockedVersions.filter(
                                    (item) => !sameVersion(item, version),
                                  ),
                            })
                          }
                        />
                        <span className="font-mono text-neutral-800">{version}</span>
                        {blockedAt && (
                          <span className="text-[11px] text-neutral-500">
                            {formatPlatformTimestamp(blockedAt)}부터 차단
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 서버가 셀 수 없는 것만 보여준다. 지금 몇 명이 막히는지. */
export function BlastRadiusView({ radius }: { radius: UpdateBlastRadius }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3">
      <div className="text-xs font-medium text-neutral-700">영향 범위</div>
      <div className="mt-1 text-sm text-neutral-900">
        지금 접속 중인 {formatPlatformCount(radius.totalSessions)}명 중{" "}
        <strong>{formatPlatformCount(radius.blockedSessions)}명</strong>이 막힙니다.
      </div>
      {radius.byPlatform.length > 0 && (
        <div className="mt-1 text-[11px] text-neutral-500">
          {radius.byPlatform
            .map((entry) => `${entry.platform} ${entry.sessions}`)
            .join(" · ")}
        </div>
      )}
      {radius.warnings.map((warning) => (
        <p
          key={warning.code}
          className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800"
        >
          {warning.message}
        </p>
      ))}
    </div>
  );
}
