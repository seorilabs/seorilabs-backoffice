export const PLAY_STATE_PREFIX = "play:v2:";
export const PLAY_UNAVAILABLE = `${PLAY_STATE_PREFIX}unavailable`;
export const PLAY_LIFECYCLES = [
  "DRAFT", "NOT_SENT_FOR_REVIEW", "IN_REVIEW", "APPROVED_NOT_PUBLISHED",
  "NOT_APPROVED", "PUBLISHED",
] as const;
export type PlayLifecycle = typeof PLAY_LIFECYCLES[number];
export type PlayTrackStatus = "completed" | "inProgress" | "halted" | "draft";

export interface PlayReleaseState {
  lifecycle: PlayLifecycle;
  status: PlayTrackStatus;
  userFraction: number | null;
}

export function playStateError(state: PlayReleaseState): string | null {
  if (!PLAY_LIFECYCLES.includes(state.lifecycle)) return "알 수 없는 출시 단계";
  if (!["completed", "inProgress", "halted", "draft"].includes(state.status)) return "알 수 없는 트랙 상태";
  const fraction = state.userFraction;
  if (fraction !== null && (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1)) return "잘못된 출시율";
  if (state.status === "inProgress" && fraction === null) return "단계적 출시율 없음";
  if (["completed", "draft"].includes(state.status) && fraction !== null) return "트랙 상태와 출시율 불일치";
  if ((state.lifecycle === "DRAFT") !== (state.status === "draft")) return "출시 단계와 초안 상태 불일치";
  return null;
}

export function encodePlayState(state: PlayReleaseState): string {
  if (playStateError(state)) return PLAY_UNAVAILABLE;
  return `${PLAY_STATE_PREFIX}${state.lifecycle}:${state.status}:${state.userFraction ?? ""}`;
}

export function decodePlayState(value: string): PlayReleaseState | null {
  if (!value.startsWith(PLAY_STATE_PREFIX) || value === PLAY_UNAVAILABLE) return null;
  const parts = value.slice(PLAY_STATE_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const state = {
    lifecycle: parts[0] as PlayLifecycle,
    status: parts[1] as PlayTrackStatus,
    userFraction: parts[2] === "" ? null : Number(parts[2]),
  };
  return playStateError(state) ? null : state;
}

export function describePlayState(value: string, trackName?: string | null): {
  label: string; emoji: "…" | "⟳" | "✓" | "✗" | "⏹";
} {
  const state = decodePlayState(value);
  if (!state) return { label: "출시 상태 확인 불가", emoji: "…" };
  const labels = {
    DRAFT: "작성 중", NOT_SENT_FOR_REVIEW: "심사 제출 대기", IN_REVIEW: "심사 중",
    APPROVED_NOT_PUBLISHED: "승인 완료 · 게시 대기", NOT_APPROVED: "심사 거절",
  };
  if (state.lifecycle !== "PUBLISHED") return {
    label: labels[state.lifecycle],
    emoji: state.lifecycle === "NOT_APPROVED" ? "✗" : state.lifecycle === "IN_REVIEW" ? "⟳" : "…",
  };
  const trackType = trackName?.split(":").at(-1);
  const production = trackType === "production";
  const track = production ? "프로덕션" : ["internal", "qa"].includes(trackType ?? "") ? "내부 테스트"
    : trackType === "beta" ? "공개 테스트" : "비공개 테스트";
  const fractionLabel = state.userFraction === null ? "" : `${Number((state.userFraction * 100).toPrecision(12))}%`;
  if (state.status === "halted") return {
    label: `${track} 출시 중지${fractionLabel ? ` · ${fractionLabel}` : ""}`, emoji: "⏹",
  };
  const availability = production ? "프로덕션 공개 확인" : `${track} 제공 확인`;
  return {
    label: `${availability} · ${state.status === "completed" ? "전체 출시" : `${fractionLabel} 단계적 출시`}`,
    emoji: state.status === "completed" ? "✓" : "⟳",
  };
}
