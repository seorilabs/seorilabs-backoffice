import type { PlatformOperationKey } from "@/lib/platform/operations";

export interface PlatformRecoveryReference {
  requestId: string;
  appSlug: string;
  operation: PlatformOperationKey;
}

export interface PlatformBlockingReference extends PlatformRecoveryReference {
  state: "in_progress" | "unknown" | "expired_unknown";
}

export interface PlatformRecoveryRetryRequest extends PlatformRecoveryReference {
  fingerprint: null;
  platformUserId: "";
}

export interface PlatformBlockingRecoveryView {
  retryRequest: PlatformRecoveryRetryRequest;
  writeState: "submitting" | "unknown" | "expired_unknown";
  summary: string;
}

export interface PlatformBlockingEnqueueRecoveryPlan {
  active: PlatformBlockingRecoveryView;
  referencesToPreserve: PlatformRecoveryReference[];
}

export const PLATFORM_RECOVERY_LEGACY_STORAGE_KEY =
  "seorilabs.platform.iap.pending.v1";
export const PLATFORM_RECOVERY_STORAGE_PREFIX =
  "seorilabs.platform.iap.pending.v2.";

export interface PlatformRecoveryStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 새로고침으로 payload fingerprint를 잃은 참조는 DB 미존재 확인 전까지
 * 재전송하지 않는다. 확인 뒤에도 request ID는 그대로 써서 지연 commit과
 * 경합하더라도 DB unique key와 플랫폼 멱등 키가 중복 적용을 막는다.
 */
export function canSubmitPlatformRecovery(
  previous: { fingerprint: string | null } | null,
  serverRowConfirmedMissing: boolean,
): boolean {
  return (
    previous === null ||
    previous.fingerprint !== null ||
    serverRowConfirmedMissing
  );
}

/** 저장 payload가 없는 서버 참조를 화면의 fail-close 재시도 상태로 바꾼다. */
export function platformRecoveryRetryRequest(
  reference: PlatformRecoveryReference,
): PlatformRecoveryRetryRequest {
  return {
    ...platformRecoveryStorageValue(reference),
    fingerprint: null,
    platformUserId: "",
  };
}

/** 서버 blocker 상태를 실제 화면에서 활성화할 최소 view-model로 투영한다. */
export function platformBlockingRecoveryView(
  reference: PlatformBlockingReference,
): PlatformBlockingRecoveryView {
  if (reference.state === "expired_unknown") {
    return {
      retryRequest: platformRecoveryRetryRequest(reference),
      writeState: "expired_unknown",
      summary:
        "서버에서 만료된 결과 미확인 요청을 찾았습니다. 원장과 감사 로그 대조 후 판정을 기록해야 합니다.",
    };
  }
  if (reference.state === "in_progress") {
    return {
      retryRequest: platformRecoveryRetryRequest(reference),
      writeState: "submitting",
      summary:
        "다른 브라우저 또는 탭에서 시작한 플랫폼 요청이 처리 중입니다. 동일 request ID 상태를 확인하세요.",
    };
  }
  return {
    retryRequest: platformRecoveryRetryRequest(reference),
    writeState: "unknown",
    summary:
      "서버에서 결과 미확인 요청을 찾았습니다. 새 request ID를 만들지 말고 동일 ID로 복구하세요.",
  };
}

/**
 * enqueue가 다른 서버 blocker를 반환하면 방금 만든 미등록 ID도 버리지 않는다.
 * blocker를 먼저 활성화하고 두 참조를 모두 보존해야 blocker 종료 뒤 원 요청을
 * 같은 ID로 재개할 수 있다.
 */
export function platformBlockingEnqueueRecoveryPlan(
  attempted: PlatformRecoveryReference,
  result: { blockingReference?: PlatformBlockingReference },
): PlatformBlockingEnqueueRecoveryPlan | null {
  if (!result.blockingReference) return null;

  const references = new Map<string, PlatformRecoveryReference>();
  for (const reference of [attempted, result.blockingReference]) {
    const safe = platformRecoveryStorageValue(reference);
    references.set(safe.requestId, safe);
  }
  return {
    active: platformBlockingRecoveryView(result.blockingReference),
    referencesToPreserve: [...references.values()],
  };
}

/** localStorage에서 읽은 값은 신뢰하지 않고 비민감 복구 참조만 허용한다. */
export function parsePlatformRecoveryReference(
  value: unknown,
): PlatformRecoveryReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate.requestId,
    ) ||
    typeof candidate.appSlug !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(candidate.appSlug) ||
    (candidate.operation !== "platform.iap.grant-entitlement" &&
      candidate.operation !== "platform.iap.revoke-entitlement" &&
      candidate.operation !== "platform.iap.reset-app-store-sandbox" &&
      candidate.operation !== "platform.iap.decide-refund-review")
  ) {
    return null;
  }
  return {
    requestId: candidate.requestId,
    appSlug: candidate.appSlug,
    operation: candidate.operation,
  };
}

/** PUID·entitlement·reason·confirmation·payload hash를 저장하지 않는 명시 투영. */
export function platformRecoveryStorageValue(
  reference: PlatformRecoveryReference,
): PlatformRecoveryReference {
  return {
    requestId: reference.requestId,
    appSlug: reference.appSlug,
    operation: reference.operation,
  };
}

function platformRecoveryStorageKey(requestId: string): string {
  return `${PLATFORM_RECOVERY_STORAGE_PREFIX}${requestId}`;
}

/** 탭마다 다른 request ID를 별도 key에 저장해 서로 덮어쓰지 않게 한다. */
export function savePlatformRecoveryReference(
  storage: PlatformRecoveryStorage,
  reference: PlatformRecoveryReference,
): void {
  const safe = parsePlatformRecoveryReference(reference);
  if (!safe) throw new Error("플랫폼 복구 참조가 올바르지 않습니다.");
  storage.setItem(
    platformRecoveryStorageKey(safe.requestId),
    JSON.stringify(platformRecoveryStorageValue(safe)),
  );
}

/** 저장소 전체를 신뢰하지 않고 key와 payload request ID가 모두 맞는 행만 읽는다. */
export function listPlatformRecoveryReferences(
  storage: PlatformRecoveryStorage,
): PlatformRecoveryReference[] {
  const references = new Map<string, PlatformRecoveryReference>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(PLATFORM_RECOVERY_STORAGE_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const reference = parsePlatformRecoveryReference(JSON.parse(raw));
      if (
        reference &&
        key === platformRecoveryStorageKey(reference.requestId)
      ) {
        references.set(reference.requestId, reference);
      }
    } catch {
      // 손상된 브라우저 값은 복구 근거로 사용하지 않는다.
    }
  }
  return [...references.values()].sort((a, b) =>
    a.requestId.localeCompare(b.requestId),
  );
}

export function removePlatformRecoveryReference(
  storage: PlatformRecoveryStorage,
  requestId: string,
): void {
  storage.removeItem(platformRecoveryStorageKey(requestId));
}

/** 단일 key를 쓰던 v1 값은 삭제하지 않고 v2 request별 key로 한 번 옮긴다. */
export function migrateLegacyPlatformRecoveryReference(
  storage: PlatformRecoveryStorage,
): void {
  const raw = storage.getItem(PLATFORM_RECOVERY_LEGACY_STORAGE_KEY);
  if (!raw) return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // 손상된 v1 값은 v2 복구 근거로 승격하지 않는다.
    storage.removeItem(PLATFORM_RECOVERY_LEGACY_STORAGE_KEY);
    return;
  }
  const reference = parsePlatformRecoveryReference(decoded);
  if (!reference) {
    storage.removeItem(PLATFORM_RECOVERY_LEGACY_STORAGE_KEY);
    return;
  }

  // v2 저장이 실패하면 v1을 보존하고 예외를 전달한다. 먼저 지우면 quota나
  // 브라우저 정책 오류 한 번으로 유일한 동일-ID 복구 근거를 잃는다.
  savePlatformRecoveryReference(storage, reference);
  storage.removeItem(PLATFORM_RECOVERY_LEGACY_STORAGE_KEY);
}
