"use client";

import React, { useEffect, useState } from "react";

import type { PlatformPresenceSnapshot } from "@/lib/platform/presence";
import {
  PlatformBadge,
  PlatformEmptyState,
  PlatformPanel,
  formatPlatformCount,
  formatPlatformTimestamp,
} from "./PlatformUi";

const EDGE_READY_URL = "https://edge.vzyx.xyz/health/ready";
const EDGE_TIMEOUT_MS = 2_000;
const REFRESH_INTERVAL_MS = 30_000;
const LAST_HEALTHY_STORAGE_KEY = "seorilabs.platform.presence.lastHealthy.v1";

export type PlatformPresenceState = "checking" | "available" | "unavailable";

export interface PlatformPresencePanelProps {
  initialSnapshot?: PlatformPresenceSnapshot | null;
}

/**
 * Edge와 DB 집계가 모두 정상일 때만 현재 숫자를 보여준다.
 * 장애 중 만료된 행을 0명으로 오인하지 않도록 마지막 정상값은 별도 보관한다.
 */
export function PlatformPresencePanel({
  initialSnapshot = null,
}: PlatformPresencePanelProps) {
  const [state, setState] = useState<PlatformPresenceState>("checking");
  const [current, setCurrent] = useState<PlatformPresenceSnapshot | null>(null);
  const [lastHealthy, setLastHealthy] =
    useState<PlatformPresenceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const cached = readLastHealthySnapshot();
    if (cached) setLastHealthy(cached);

    async function refresh(candidate?: PlatformPresenceSnapshot | null) {
      try {
        await assertEdgeReady();
        const snapshot = candidate ?? (await fetchPresenceSnapshot());
        if (!active) return;
        setCurrent(snapshot);
        setLastHealthy(snapshot);
        writeLastHealthySnapshot(snapshot);
        setState("available");
        setError(null);
      } catch (caught) {
        if (!active) return;
        setCurrent(null);
        setState("unavailable");
        setError(
          caught instanceof Error ? caught.message : "동접 상태를 확인하지 못했습니다.",
        );
      }
    }

    void refresh(initialSnapshot);
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [initialSnapshot]);

  return (
    <PlatformPresenceView
      state={state}
      current={current}
      lastHealthy={lastHealthy}
      error={error}
    />
  );
}

export interface PlatformPresenceViewProps {
  state: PlatformPresenceState;
  current: PlatformPresenceSnapshot | null;
  lastHealthy: PlatformPresenceSnapshot | null;
  error?: string | null;
}

/** 상태 표현을 순수 컴포넌트로 유지해 장애 중 0명 오표시를 검증한다. */
export function PlatformPresenceView({
  state,
  current,
  lastHealthy,
  error = null,
}: PlatformPresenceViewProps) {
  return (
    <PlatformPanel
      title="실시간 동접"
      description="RPI Edge가 받은 최근 heartbeat를 150초 활성 창으로 집계합니다."
      trailing={<PresenceStatusBadge state={state} />}
    >
      {state === "available" && current ? (
        <PresenceNumbers snapshot={current} />
      ) : state === "checking" ? (
        <PlatformEmptyState title="RPI Edge 확인 중">
          공개 HTTPS 경로와 MySQL 집계를 함께 확인하고 있습니다.
        </PlatformEmptyState>
      ) : (
        <div>
          <PlatformEmptyState title="동접 알 수 없음">
            {error ?? "RPI Edge 또는 집계 DB가 응답하지 않습니다."} 장애 중 만료된
            세션을 0명으로 표시하지 않습니다.
          </PlatformEmptyState>
          {lastHealthy && (
            <div className="border-t border-neutral-100 px-4 py-3 text-xs text-neutral-600">
              마지막 정상값 {formatPlatformCount(lastHealthy.totalActiveSessions)}명 · {" "}
              {formatPlatformTimestamp(lastHealthy.measuredAt)}
            </div>
          )}
        </div>
      )}
      <div className="border-t border-neutral-100 px-4 py-3 text-[11px] leading-4 text-neutral-500">
        이 수치는 연결 소켓 수가 아니라 최근 {current?.activeTtlSeconds ?? 150}초 안에
        heartbeat가 도착한 익명 세션 수입니다. Edge 장애 시 클라이언트는 최대 2초
        뒤 관측만 포기하며 게임·인증·결제 동작을 차단하지 않습니다.
      </div>
    </PlatformPanel>
  );
}

function PresenceNumbers({ snapshot }: { snapshot: PlatformPresenceSnapshot }) {
  return (
    <div>
      <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4">
          <div className="text-xs font-medium text-emerald-800">전체 최근 활성</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums text-emerald-950">
            {formatPlatformCount(snapshot.totalActiveSessions)}
            <span className="ml-1 text-sm font-medium">명</span>
          </div>
          <div className="mt-2 text-[11px] text-emerald-700">
            집계 {formatPlatformTimestamp(snapshot.measuredAt)}
          </div>
        </div>
        <div className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
          {snapshot.apps.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-neutral-500">
              현재 활성 세션이 없습니다.
            </div>
          ) : (
            snapshot.apps.map((app) => (
              <div
                key={app.appId}
                className="flex items-center justify-between gap-4 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-neutral-800">
                    {app.displayName}
                  </div>
                  <div className="truncate font-mono text-[10px] text-neutral-400">
                    {app.appId}
                  </div>
                </div>
                <div className="shrink-0 text-sm font-semibold tabular-nums text-neutral-900">
                  {formatPlatformCount(app.activeSessions)}명
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function PresenceStatusBadge({ state }: { state: PlatformPresenceState }) {
  if (state === "available") {
    return <PlatformBadge tone="green">Edge 정상</PlatformBadge>;
  }
  if (state === "unavailable") {
    return <PlatformBadge tone="amber">알 수 없음</PlatformBadge>;
  }
  return <PlatformBadge tone="neutral">확인 중</PlatformBadge>;
}

async function assertEdgeReady(): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), EDGE_TIMEOUT_MS);
  try {
    const response = await fetch(EDGE_READY_URL, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("RPI Edge가 준비되지 않았습니다.");
  } catch {
    throw new Error("RPI Edge가 응답하지 않습니다.");
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchPresenceSnapshot(): Promise<PlatformPresenceSnapshot> {
  const response = await fetch("/api/platform/presence", { cache: "no-store" });
  if (!response.ok) throw new Error("presence 집계를 읽지 못했습니다.");
  const body: unknown = await response.json();
  if (!isPresenceResponse(body)) {
    throw new Error("presence 집계 응답이 올바르지 않습니다.");
  }
  return body.snapshot;
}

function isPresenceResponse(
  value: unknown,
): value is { ok: true; snapshot: PlatformPresenceSnapshot } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { ok?: unknown; snapshot?: unknown };
  if (candidate.ok !== true || !candidate.snapshot || typeof candidate.snapshot !== "object") {
    return false;
  }
  return isPresenceSnapshot(candidate.snapshot);
}

function isPresenceSnapshot(value: unknown): value is PlatformPresenceSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<PlatformPresenceSnapshot>;
  return (
    Number.isInteger(snapshot.totalActiveSessions) &&
    Number(snapshot.totalActiveSessions) >= 0 &&
    typeof snapshot.measuredAt === "string" &&
    Number.isInteger(snapshot.activeTtlSeconds) &&
    Number(snapshot.activeTtlSeconds) > 0 &&
    Array.isArray(snapshot.apps) &&
    snapshot.apps.every(
      (app) =>
        app != null &&
        typeof app === "object" &&
        typeof app.appId === "string" &&
        typeof app.displayName === "string" &&
        Number.isInteger(app.activeSessions) &&
        app.activeSessions >= 0 &&
        typeof app.lastSeenAt === "string",
    )
  );
}

function readLastHealthySnapshot(): PlatformPresenceSnapshot | null {
  try {
    const raw = window.localStorage.getItem(LAST_HEALTHY_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return isPresenceSnapshot(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLastHealthySnapshot(snapshot: PlatformPresenceSnapshot): void {
  try {
    window.localStorage.setItem(LAST_HEALTHY_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // private browsing·quota 오류도 presence 화면을 깨지 않는다.
  }
}
