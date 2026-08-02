export type PlatformTone = "neutral" | "blue" | "green" | "amber" | "red";

export interface PlatformPresentation {
  label: string;
  tone: PlatformTone;
}

export type PlatformConnectionState =
  | "connected"
  | "degraded"
  | "unavailable"
  | "unconfigured";

export type PlatformCapabilityState = "available" | "partial" | "unavailable";

export type PlatformWriteState =
  | "idle"
  | "submitting"
  | "success"
  | "error"
  | "unknown"
  | "expired_unknown";

export function environmentPresentation(
  environment: string | null | undefined,
): PlatformPresentation {
  switch (environment?.trim().toLowerCase()) {
    case "production":
      return { label: "Production 원장", tone: "red" };
    case "sandbox":
      return { label: "Sandbox 원장", tone: "amber" };
    case "staging":
      return { label: "Staging", tone: "blue" };
    default:
      return { label: "환경 미확인", tone: "neutral" };
  }
}

export function connectionPresentation(
  state: PlatformConnectionState,
): PlatformPresentation {
  const states: Record<PlatformConnectionState, PlatformPresentation> = {
    connected: { label: "연결됨", tone: "green" },
    degraded: { label: "점검 필요", tone: "amber" },
    unavailable: { label: "연결 실패", tone: "red" },
    unconfigured: { label: "미설정", tone: "neutral" },
  };
  return states[state];
}

export function capabilityPresentation(
  state: PlatformCapabilityState,
): PlatformPresentation {
  const states: Record<PlatformCapabilityState, PlatformPresentation> = {
    available: { label: "사용 가능", tone: "green" },
    partial: { label: "일부 지원", tone: "amber" },
    unavailable: { label: "미지원", tone: "neutral" },
  };
  return states[state];
}

export function deadLetterPresentation(
  count: number | null | undefined,
): PlatformPresentation {
  if (count == null || !Number.isInteger(count) || count < 0) {
    return { label: "미확인", tone: "neutral" };
  }
  return count === 0
    ? { label: "0건 · 정상", tone: "green" }
    : { label: `${count}건 · 확인 필요`, tone: "red" };
}

export function writeStatePresentation(
  state: PlatformWriteState,
): PlatformPresentation {
  const states: Record<PlatformWriteState, PlatformPresentation> = {
    idle: { label: "변경 작업 대기", tone: "neutral" },
    submitting: { label: "처리 중", tone: "amber" },
    success: { label: "처리 완료", tone: "green" },
    error: { label: "처리 실패", tone: "red" },
    unknown: { label: "결과 미확인", tone: "amber" },
    expired_unknown: { label: "대조 필요", tone: "red" },
  };
  return states[state];
}
