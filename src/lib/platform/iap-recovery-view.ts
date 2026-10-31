import type { PlatformOperationKey } from "./operations";

export type PlatformManualIapOperation =
  | "platform.iap.grant-entitlement"
  | "platform.iap.revoke-entitlement"
  | "platform.iap.reset-app-store-sandbox";

const labels: Record<PlatformOperationKey, string> = {
  "platform.iap.grant-entitlement": "Entitlement 지급",
  "platform.iap.revoke-entitlement": "Entitlement 회수",
  "platform.iap.reset-app-store-sandbox": "App Store Sandbox 원장 초기화",
  "platform.iap.decide-refund-review": "Google Play 환불 검토 결정",
  "platform.iap.set-economy-tester": "크리스털 시험 계정 변경",
  "platform.ads.grant-suppression": "광고 차단 지급",
  "platform.ads.revoke-suppression": "광고 차단 회수",
  "platform.config.set-update-policy": "업데이트 정책 변경",
  "platform.inbox.issue": "Starter 우편 발송",
};

interface RecoveryDestination {
  href: string;
  label: string;
}

const destinations: Partial<Record<PlatformOperationKey, RecoveryDestination>> = {
  "platform.ads.grant-suppression": { href: "/platform/ads", label: "광고 관리" },
  "platform.ads.revoke-suppression": { href: "/platform/ads", label: "광고 관리" },
  "platform.iap.set-economy-tester": {
    href: "/platform/iap/crystal-testers",
    label: "크리스털 시험 계정 관리",
  },
  "platform.config.set-update-policy": {
    href: "/platform/updates",
    label: "업데이트 정책 관리",
  },
  "platform.inbox.issue": { href: "/platform/inbox", label: "우편 관리" },
};

export function platformIapOperationLabel(operation: PlatformOperationKey): string {
  return labels[operation];
}

/** 다른 관리 작업의 참조는 보존하되 IAP 입력과 재실행에 사용하지 않는다. */
export function platformIapRecoveryView(operation: PlatformOperationKey): {
  label: string;
  manualOperation: PlatformManualIapOperation | null;
  destination: RecoveryDestination | null;
} {
  return {
    label: platformIapOperationLabel(operation),
    manualOperation:
      operation === "platform.iap.grant-entitlement" ||
      operation === "platform.iap.revoke-entitlement" ||
      operation === "platform.iap.reset-app-store-sandbox"
        ? operation
        : null,
    destination: destinations[operation] ?? null,
  };
}
