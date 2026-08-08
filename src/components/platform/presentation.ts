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

/**
 * 개요 화면의 연결 상태를 정한다.
 *
 * 이 판정을 page에서 삼항 연산자로 두면 test로 고정할 수 없다. 실제로
 * 환경 불일치가 조용히 넘어가 운영자가 못 보는 사고가 있었으므로,
 * 무엇이 degraded인지는 계약으로 박아 둔다.
 *
 * `healthReachable`은 health 조회만 본다. 예전에는 주문·감사 조회까지
 * 한 덩어리로 묶어 판정해서, 감사 기록 하나가 계약 검증에 걸리면
 * 멀쩡한 Admin API가 "연결 실패"로 표시됐다. 운영자는 네트워크나
 * 자격증명을 의심하게 되고 진짜 원인은 화면 어디에도 없었다.
 * 개별 조회 실패는 degraded지 unavailable이 아니다.
 */
export function overviewConnectionState(input: {
  configured: boolean;
  healthReachable: boolean;
  deadLetterCount: number;
  environmentMismatchCount: number;
  failedSectionCount: number;
  hiddenRecordCount?: number;
}): PlatformConnectionState {
  if (!input.configured) return "unconfigured";
  if (!input.healthReachable) return "unavailable";
  // 환경 불일치는 dead-letter와 같은 등급이다. 서비스는 살아 있지만
  // 운영자가 할 수 있는 일이 막혀 있다.
  //
  // 제외된 기록도 같은 등급이다. 조회는 성공했지만 목록이 불완전한데,
  // 배지가 초록이면 운영자가 목록을 완전한 것으로 믿는다.
  if (
    input.deadLetterCount > 0 ||
    input.environmentMismatchCount > 0 ||
    input.failedSectionCount > 0 ||
    (input.hiddenRecordCount ?? 0) > 0
  ) {
    return "degraded";
  }
  return "connected";
}

/**
 * 개요 화면의 요약 문구를 정한다.
 *
 * 환경 불일치를 dead-letter보다 먼저 알린다. dead-letter는 재시도가 돌지만
 * 환경 불일치는 사람이 regsync를 돌리기 전에는 저절로 낫지 않는다.
 *
 * 개별 조회 실패는 맨 뒤다. 조회가 하나 안 되는 것보다 원장 환경이
 * 어긋나 지급이 전부 막힌 쪽이 급하다. 실패한 조회의 실제 원인은
 * 화면이 구획별로 따로 보여준다.
 */
export function overviewMessage(input: {
  configuredMessage: string | null;
  errorMessage: string | null;
  deadLetterCount: number;
  environmentMismatchCount: number;
  failedSectionLabels?: readonly string[];
}): string {
  if (input.configuredMessage) return input.configuredMessage;
  if (input.errorMessage) return input.errorMessage;
  if (input.environmentMismatchCount > 0) {
    return "레지스트리와 원장 환경이 어긋나 일부 앱의 운영 조작이 막혀 있습니다.";
  }
  if (input.deadLetterCount > 0) {
    return "IAP dead-letter가 있어 완료 처리 상태 확인이 필요합니다.";
  }
  const failed = input.failedSectionLabels ?? [];
  if (failed.length > 0) {
    return `Admin API는 정상이지만 ${failed.join(", ")} 조회가 실패했습니다.`;
  }
  return "조회 전용 연결과 플랫폼 운영 상태를 확인했습니다.";
}
