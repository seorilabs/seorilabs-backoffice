import type {
  PlatformAdClaim,
  PlatformAdsHealth,
  PlatformUserAds,
} from "@/lib/platform/client";

export type AdsLookupState =
  | "idle"
  | "loading"
  | "not_found"
  | "read_failure"
  | "allowed"
  | "suppressed"
  | "not_applicable";

export function adsLookupState(input: {
  requested: boolean;
  loading: boolean;
  errorCode?: string;
  user?: PlatformUserAds | null;
}): AdsLookupState {
  if (input.loading) return "loading";
  if (input.user) {
    if (!input.user.policy.appUsesAds) return "not_applicable";
    return input.user.policy.adsEnabled ? "allowed" : "suppressed";
  }
  if (!input.requested) return "idle";
  if (input.errorCode === "not_found" || input.errorCode === "user_not_found") {
    return "not_found";
  }
  return "read_failure";
}

export function adsHealthLabel(
  health: PlatformAdsHealth | null,
): "정상" | "확인 실패" {
  return health?.status === "ok" ? "정상" : "확인 실패";
}

export function adsAssuranceLabel(
  assurance: PlatformAdClaim["assurance"],
): "서버 서명 검증" | "클라이언트 확인" | "대기" {
  if (assurance === "server_verified") return "서버 서명 검증";
  if (assurance === "client_confirmed") return "클라이언트 확인";
  return "대기";
}

export function activeAdsSuppressionGrant(
  user: PlatformUserAds | null,
): string | undefined {
  if (!user?.policy.disabledBy.includes("operator")) return undefined;
  const revoked = new Set(
    user.auditHistory
      .filter((record) => record.operation === "revoke" && record.applied)
      .map((record) => record.grantRequestId),
  );
  return user.auditHistory.find(
    (record) =>
      record.operation === "grant" &&
      record.applied &&
      !revoked.has(record.requestId),
  )?.requestId;
}

export type AdsQueueDisplay =
  | "대기"
  | "실행 중"
  | "완료"
  | "실패"
  | "결과 미확인";

export function adsQueueDisplay(input: {
  ok: boolean;
  found?: boolean;
  status?: string;
  conclusion?: string | null;
  outcomeUnknown?: boolean;
  outcomeExpired?: boolean;
}): AdsQueueDisplay {
  if (!input.ok || input.outcomeUnknown || input.outcomeExpired)
    return "결과 미확인";
  if (!input.found || input.status === "queued" || input.status === "waiting")
    return "대기";
  if (input.status === "in_progress") return "실행 중";
  if (input.status === "completed" && input.conclusion === "success")
    return "완료";
  if (input.status === "completed" && input.conclusion === "failure")
    return "실패";
  return "결과 미확인";
}

export function adsConfigDriftWarning(
  registrySyncedAt: string,
  localConfigSyncedAt?: string,
): string | null {
  if (!localConfigSyncedAt) return null;
  const registryAt = Date.parse(registrySyncedAt);
  const localAt = Date.parse(localConfigSyncedAt);
  if (!Number.isFinite(registryAt) || !Number.isFinite(localAt)) {
    return "앱 로컬 설정과 Platform registry 동기화 시각을 비교하지 못했습니다.";
  }
  if (localAt > registryAt) {
    return "앱 로컬 설정이 Platform registry보다 나중에 동기화됐습니다. 광고 설정 불일치 여부를 확인하세요.";
  }
  return null;
}
