"use server";

import type {
  PlatformAppIapCatalog,
  PlatformHealth,
  PlatformOperatorRecord,
  PlatformOrder,
  PlatformUser,
} from "@/lib/platform/client";
import { PlatformApiError } from "@/lib/platform/client";
import {
  PlatformAccessError,
  requirePlatformReadAccess,
  requirePlatformWriteAccess,
} from "@/lib/platform/access";
import { createPlatformReadClient } from "@/lib/platform/read-client";
import {
  isPlatformUserId,
  normalizePlatformReference,
  PlatformReadInputError,
  publicPlatformEntitlement,
  publicPlatformOperatorRecord,
  publicPlatformOrder,
  publicPlatformUser,
  type PlatformEntitlementSummary,
} from "@/lib/platform/read-contract";

export interface PlatformActionFailure {
  ok: false;
  error: string;
  code?: string;
}

export interface PlatformActionSuccess<T> {
  ok: true;
  data: T;
}

export type PlatformActionResult<T> =
  | PlatformActionSuccess<T>
  | PlatformActionFailure;

export interface PlatformIapSnapshot {
  health: PlatformHealth;
  orders: PlatformOrder[];
  operatorRecords: PlatformOperatorRecord[];
  checkedAt: string;
}

export type PlatformIapCatalog = PlatformAppIapCatalog;

export interface PlatformEntitlementLookup {
  platformUserId: string;
  entitlements: PlatformEntitlementSummary[];
}

function failure(error: unknown): PlatformActionFailure {
  if (error instanceof PlatformAccessError) {
    return { ok: false, code: "forbidden", error: error.message };
  }
  if (error instanceof PlatformReadInputError) {
    return { ok: false, code: "invalid_input", error: error.message };
  }
  if (error instanceof PlatformApiError) {
    return { ok: false, code: error.code, error: error.message };
  }
  return {
    ok: false,
    code: "platform_unavailable",
    error: "플랫폼을 조회하지 못했습니다.",
  };
}

/** 플랫폼 연결·IAP 상태를 한 번의 화면 새로고침에 맞춰 읽는다. */
export async function loadPlatformIapSnapshotAction(): Promise<
  PlatformActionResult<PlatformIapSnapshot>
> {
  try {
    await requirePlatformReadAccess();
    const client = createPlatformReadClient();
    const [health, orders, records] = await Promise.all([
      client.health(),
      client.recentOrders(50),
      client.operatorRecords(50),
    ]);
    return {
      ok: true,
      data: {
        health,
        orders: orders.map(publicPlatformOrder),
        operatorRecords: [...records.grants, ...records.revocations]
          .map(publicPlatformOperatorRecord)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
        checkedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/** 선택 앱의 entitlement allowlist만 읽는다. UI 전환 race도 appId로 재확인한다. */
export async function loadPlatformIapCatalogAction(
  appSlug: string,
): Promise<PlatformActionResult<PlatformIapCatalog>> {
  try {
    const actor = await requirePlatformWriteAccess(appSlug);
    const client = createPlatformReadClient();
    const catalog = await client.catalogEntitlements(actor.appSlug);
    if (catalog.appId !== actor.appSlug) {
      throw new PlatformApiError(
        "platform_response_invalid",
        "플랫폼 entitlement 카탈로그 응답 대상이 요청과 일치하지 않습니다.",
        200,
      );
    }
    return { ok: true, data: catalog };
  } catch (error) {
    return failure(error);
  }
}

/** PUID 또는 support code로 PII 없는 인증 사용자 요약을 찾는다. */
export async function lookupPlatformUserAction(
  reference: string,
): Promise<PlatformActionResult<PlatformUser>> {
  try {
    await requirePlatformReadAccess();
    const client = createPlatformReadClient();
    return {
      ok: true,
      data: publicPlatformUser(
        await client.user(normalizePlatformReference(reference)),
      ),
    };
  } catch (error) {
    return failure(error);
  }
}

/** 사용자별 entitlement와 source를 조회한다. */
export async function lookupPlatformEntitlementsAction(
  platformUserId: string,
): Promise<PlatformActionResult<PlatformEntitlementLookup>> {
  try {
    await requirePlatformReadAccess();
    const reference = normalizePlatformReference(platformUserId);
    if (!isPlatformUserId(reference)) {
      throw new PlatformReadInputError(
        "Entitlement 조회에는 플랫폼 사용자 ID가 필요합니다.",
      );
    }
    const client = createPlatformReadClient();
    return {
      ok: true,
      data: {
        platformUserId: reference,
        entitlements: (await client.userEntitlements(reference)).map(
          publicPlatformEntitlement,
        ),
      },
    };
  } catch (error) {
    return failure(error);
  }
}
