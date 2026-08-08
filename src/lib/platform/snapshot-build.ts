import type {
  PlatformHealth,
  PlatformOperatorRecord,
  PlatformOrder,
  PlatformUserMetrics,
} from "@/lib/platform/client";
import { PlatformApiError } from "@/lib/platform/client";
import { PlatformAccessError } from "@/lib/platform/access";
import {
  PlatformReadInputError,
  publicPlatformOperatorRecord,
  publicPlatformOrder,
} from "@/lib/platform/read-contract";
import {
  PLATFORM_SECTION_LABELS,
  type PlatformIapSnapshot,
  type PlatformSectionFailure,
  type PlatformSnapshotSection,
} from "@/lib/platform/snapshot";
export type { PlatformIapSnapshot } from "@/lib/platform/snapshot";

/**
 * 서버 전용이다. 오류 분류에 client·access의 값 import가 필요해서
 * 브라우저에 들어가는 snapshot.ts와 나눠 둔다.
 */

/**
 * 조회 오류를 화면에 보여줄 수 있는 형태로 좁힌다.
 *
 * 알 수 없는 오류는 원문을 내보내지 않는다. 스택이나 내부 주소가 섞여
 * 나올 수 있다. Admin API가 준 메시지는 이미 노출 가능한 문구다.
 */
export function platformErrorView(error: unknown): {
  error: string;
  code: string;
} {
  if (error instanceof PlatformAccessError) {
    return { code: "forbidden", error: error.message };
  }
  if (error instanceof PlatformReadInputError) {
    return { code: "invalid_input", error: error.message };
  }
  if (error instanceof PlatformApiError) {
    return { code: error.code, error: error.message };
  }
  return {
    code: "platform_unavailable",
    error: "플랫폼을 조회하지 못했습니다.",
  };
}

export interface PlatformSnapshotSettled {
  health: PromiseSettledResult<PlatformHealth>;
  orders: PromiseSettledResult<{ orders: PlatformOrder[]; hidden: number }>;
  operatorRecords: PromiseSettledResult<{
    grants: PlatformOperatorRecord[];
    revocations: PlatformOperatorRecord[];
    hidden: number;
  }>;
  metrics: PromiseSettledResult<PlatformUserMetrics | null>;
}

/**
 * 네 조회 결과를 화면이 쓰는 snapshot으로 조립한다.
 *
 * 실패한 구획은 빈 값 + failures 항목이 되고, 성공한 구획은 그대로
 * 남는다. 이 분리가 이 함수의 전부이므로 순수 함수로 떼어 두고
 * test로 고정한다.
 */
export function buildPlatformIapSnapshot(
  settled: PlatformSnapshotSettled,
  checkedAt: string,
): PlatformIapSnapshot {
  const failures: PlatformSectionFailure[] = [];

  const record = (section: PlatformSnapshotSection, reason: unknown) => {
    const view = platformErrorView(reason);
    failures.push({
      section,
      label: PLATFORM_SECTION_LABELS[section],
      error: view.error,
      code: view.code,
    });
  };

  if (settled.health.status === "rejected") {
    record("health", settled.health.reason);
  }
  if (settled.orders.status === "rejected") {
    record("orders", settled.orders.reason);
  }
  if (settled.operatorRecords.status === "rejected") {
    record("operatorRecords", settled.operatorRecords.reason);
  }
  if (settled.metrics.status === "rejected") {
    record("metrics", settled.metrics.reason);
  }

  const operatorRecords =
    settled.operatorRecords.status === "fulfilled"
      ? [
          ...settled.operatorRecords.value.grants,
          ...settled.operatorRecords.value.revocations,
        ]
          .map(publicPlatformOperatorRecord)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      : [];

  return {
    health: settled.health.status === "fulfilled" ? settled.health.value : null,
    orders:
      settled.orders.status === "fulfilled"
        ? settled.orders.value.orders.map(publicPlatformOrder)
        : [],
    operatorRecords,
    // 조회가 실패한 구획은 0이다. 목록을 아예 못 받았으므로 "몇 건이
    // 제외됐다"고 말할 근거가 없다. 그 경우는 failures가 이미 알린다.
    hiddenOrderCount:
      settled.orders.status === "fulfilled" ? settled.orders.value.hidden : 0,
    hiddenOperatorRecordCount:
      settled.operatorRecords.status === "fulfilled"
        ? settled.operatorRecords.value.hidden
        : 0,
    metrics:
      settled.metrics.status === "fulfilled" ? settled.metrics.value : null,
    failures,
    checkedAt,
  };
}
