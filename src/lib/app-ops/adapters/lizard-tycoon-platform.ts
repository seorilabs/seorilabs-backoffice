/**
 * lizard-tycoon IAP 운영을 공통 플랫폼 Admin API로 처리한다.
 *
 * 같은 operation을 기존 어댑터는 firebase-admin으로 앱 Firestore를 직접
 * 조작해 처리했다. 이쪽은 플랫폼 API만 부른다. 백오피스가 SA 키를
 * 보관하지 않고, IAP 원장 불변식은 플랫폼 한 곳에서만 지켜진다.
 *
 * `FEATURE_PLATFORM_ADMIN`으로 갈아탄다. 문제가 생기면 환경변수 하나로
 * 기존 경로에 돌아간다.
 */

import { env } from "../../env";
import { PlatformApiError, PlatformClient } from "../../platform/client";
import type { AppOpsResult } from "../operation";
import type { LizardTycoonOperationInput } from "./lizard-tycoon";

const APP_ID = "lizard-tycoon";

/** 조회 결과 행 수 상한. 기존 어댑터와 같다. */
const MAX_RESULT_ROWS = 20;

/**
 * 플랫폼이 아직 대신할 수 없는 operation.
 *
 * 조용히 빈 결과를 주면 운영자가 "데이터가 없다"로 읽는다.
 * 실제로는 기능이 없는 것이므로 분명히 말한다.
 */
const UNSUPPORTED: Record<string, string> = {
  "iap-ledger.sandbox-testers":
    "샌드박스 테스터 조회는 App Store Connect API가 필요해 플랫폼에 아직 없습니다.",
  "iap-ledger.refund-review-queue":
    "환불 검토 대기열은 플랫폼 Admin API에 아직 없습니다.",
  "iap-ledger.reset-app-store-sandbox":
    "App Store 샌드박스 초기화는 플랫폼 Admin API에 아직 없습니다.",
};

/** 플랫폼 경로로 처리할 수 있는 operation인지 본다. */
export function isPlatformSupportedOperation(operation: string): boolean {
  return !(operation in UNSUPPORTED);
}

/**
 * 플랫폼 경로를 쓸 조건인지 본다.
 *
 * 기능 플래그와 설정이 모두 갖춰져야 한다. 하나라도 없으면
 * 기존 어댑터가 그대로 처리한다.
 */
export function shouldUsePlatform(operation: string): boolean {
  return env.platformConfigured() && isPlatformSupportedOperation(operation);
}

export async function executeLizardTycoonPlatformOperation(
  input: LizardTycoonOperationInput,
): Promise<AppOpsResult> {
  const unsupported = UNSUPPORTED[input.operation];
  if (unsupported) {
    throw new Error(unsupported);
  }

  const client = new PlatformClient({
    baseUrl: env.platformAdminUrl(),
    serviceAccountJson: env.platformAdminSaKeyJson(),
  });

  const actor = input.actorLogin ?? "unknown";
  const result = await runOperation(client, input, actor);

  return {
    version: 1,
    requestId: input.requestId,
    operation: input.operation,
    status: "success",
    ...result,
    completedAt: new Date().toISOString(),
  };
}

type OperationOutput = Pick<AppOpsResult, "summary" | "data">;

async function runOperation(
  client: PlatformClient,
  input: LizardTycoonOperationInput,
  actor: string,
): Promise<OperationOutput> {
  switch (input.operation) {
    case "iap-ledger.recent-purchases":
      return recentPurchases(client, input);

    case "iap-ledger.account-entitlements":
      return accountEntitlements(client, input);

    case "iap-ledger.production-grants":
      return productionGrants(client, input);

    case "iap-ledger.grant-production-entitlement":
      return grantEntitlement(client, input, actor);

    case "iap-ledger.revoke-production-entitlement":
      return revokeEntitlement(client, input, actor);

    default:
      throw new Error("도마뱀 AppOps에서 허용되지 않은 오퍼레이션입니다.");
  }
}

async function recentPurchases(
  client: PlatformClient,
  input: LizardTycoonOperationInput,
): Promise<OperationOutput> {
  const limit = clampLimit(input.params.limit);
  const orders = await client.recentOrders(limit);

  return {
    summary: `최근 주문 ${orders.length}건을 조회했습니다.`,
    data: {
      // 구매 토큰과 마켓 계정 해시는 플랫폼이 응답에 넣지 않는다.
      // 화면에 뜨면 스크린샷과 로그로 퍼진다.
      rows: orders.map((order) => ({
        orderKey: order.orderKey,
        platformUserId: order.platformUserId,
        entitlementId: order.entitlementId,
        platform: order.platform,
        productId: order.productId,
        providerOrderId: order.providerOrderId,
        state: order.state,
        purchasedAt: order.purchasedAt,
        observedAt: order.observedAt,
        tombstone: order.tombstone,
      })),
    },
  };
}

async function accountEntitlements(
  client: PlatformClient,
  input: LizardTycoonOperationInput,
): Promise<OperationOutput> {
  const puid = requireString(input.params.platformUserId ?? input.params.accountRef, "사용자 식별자");
  const entitlements = await client.userEntitlements(puid);

  const active = entitlements.filter((e) => e.active).length;

  return {
    summary: `${puid}의 entitlement ${entitlements.length}건 중 ${active}건이 활성입니다.`,
    data: {
      platformUserId: puid,
      // 비활성도 함께 준다. 왜 없는지를 봐야 CS가 가능하다.
      rows: entitlements.map((e) => ({
        entitlementId: e.entitlementId,
        active: e.active,
        updatedAt: e.updatedAt,
        sources: e.sources.map((s) => ({
          platform: s.platform,
          productId: s.productId,
          state: s.state,
          observedAt: s.observedAt,
        })),
      })),
    },
  };
}

async function productionGrants(
  client: PlatformClient,
  input: LizardTycoonOperationInput,
): Promise<OperationOutput> {
  const limit = clampLimit(input.params.limit);
  const { grants, revocations } = await client.operatorRecords(limit);

  return {
    summary: `운영자 지급 ${grants.length}건, 회수 ${revocations.length}건을 조회했습니다.`,
    data: {
      grants: grants.map(toOperatorRow),
      revocations: revocations.map(toOperatorRow),
    },
  };
}

function toOperatorRow(record: {
  requestId: string;
  platformUserId: string;
  entitlementId: string;
  actorLogin: string;
  reason: string;
  createdAt: string;
}) {
  return {
    requestId: record.requestId,
    platformUserId: record.platformUserId,
    entitlementId: record.entitlementId,
    actorLogin: record.actorLogin,
    reason: record.reason,
    createdAt: record.createdAt,
  };
}

async function grantEntitlement(
  client: PlatformClient,
  input: LizardTycoonOperationInput,
  actor: string,
): Promise<OperationOutput> {
  const request = operatorRequest(input);
  const result = await client.grantEntitlement(request, actor);

  return {
    summary: result.applied
      ? `${request.platformUserId}에게 ${request.entitlementId}를 지급했습니다.`
      : `${request.platformUserId}의 ${request.entitlementId} 지급은 이미 처리된 요청입니다.`,
    data: {
      applied: result.applied,
      entitlements: result.entitlements,
      requestId: request.requestId,
    },
  };
}

async function revokeEntitlement(
  client: PlatformClient,
  input: LizardTycoonOperationInput,
  actor: string,
): Promise<OperationOutput> {
  const request = operatorRequest(input);
  const result = await client.revokeEntitlement(request, actor);

  return {
    summary: result.applied
      ? `${request.platformUserId}의 ${request.entitlementId}를 회수했습니다.`
      : `${request.platformUserId}의 ${request.entitlementId} 회수는 이미 처리된 요청입니다.`,
    data: {
      applied: result.applied,
      entitlements: result.entitlements,
      requestId: request.requestId,
    },
  };
}

/**
 * 지급·회수 요청을 만든다.
 *
 * requestId는 백오피스가 이미 멱등 키로 쓰고 있는 값을 그대로 넘긴다.
 * 재시도해도 보상이 두 번 나가지 않는 근거가 여기 있다.
 */
function operatorRequest(input: LizardTycoonOperationInput) {
  const reason = input.reason.trim();
  if (!reason) {
    // 플랫폼도 거부하지만 왕복을 아낀다.
    throw new Error("지급·회수에는 사유가 필요합니다.");
  }

  return {
    requestId: input.requestId,
    platformUserId: requireString(
      input.params.platformUserId ?? input.params.accountRef,
      "사용자 식별자",
    ),
    entitlementId: requireString(input.params.entitlementId, "entitlement"),
    reason,
    appId: APP_ID,
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}가 필요합니다.`);
  }
  return value.trim();
}

function clampLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return MAX_RESULT_ROWS;
  }
  return Math.min(Math.floor(value), MAX_RESULT_ROWS);
}

/** 플랫폼 오류를 운영자가 읽을 문장으로 바꾼다. */
export function describePlatformError(error: unknown): string {
  if (error instanceof PlatformApiError) {
    return `플랫폼 호출 실패 (${error.code}): ${error.message}`;
  }
  return error instanceof Error ? error.message : "플랫폼 호출에 실패했습니다.";
}
