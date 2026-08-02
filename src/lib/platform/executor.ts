import type { AppOpsResult } from "@/lib/app-ops/operation";
import { prepareQueuedPlatformOperation } from "@/lib/platform/operations";
import type { PlatformOperationReason } from "@/lib/platform/reasons";

import { createPlatformWriteOperationsClient } from "./executor-client";

export interface PlatformOperatorRequest {
  requestId: string;
  platformUserId: string;
  entitlementId: string;
  reason: PlatformOperationReason;
  appId: string;
  expectedEnvironment: "sandbox" | "production";
  confirmation: string;
}

export interface PlatformRevokeOperatorRequest
  extends PlatformOperatorRequest {
  grantRequestId: string;
}

export interface PlatformOperatorResult {
  applied: boolean;
  entitlements: string[];
}

export interface PlatformSandboxResetRequest {
  requestId: string;
  platformUserId: string;
  reason: PlatformOperationReason;
  appId: string;
  expectedEnvironment: "sandbox";
  confirmation: string;
  appleClearedConfirmed: true;
}

export interface PlatformSandboxResetResult {
  platformUserId: string;
  resetOrderKeys: string[];
}

/** executor가 소비하는 최소 client 포트. 실제 client 클래스에 의존하지 않는다. */
export interface PlatformOperationsClient {
  grantEntitlement(
    request: PlatformOperatorRequest,
    actor: string,
  ): Promise<PlatformOperatorResult>;
  revokeEntitlement(
    request: PlatformRevokeOperatorRequest,
    actor: string,
  ): Promise<PlatformOperatorResult>;
  resetAppStoreSandbox(
    request: PlatformSandboxResetRequest,
    actor: string,
  ): Promise<PlatformSandboxResetResult>;
}

export type PlatformOperationsClientFactory =
  () => PlatformOperationsClient | Promise<PlatformOperationsClient>;

export interface PlatformOperationExecutionInput {
  requestId: string;
  operation: string;
  params: unknown;
  actorLogin: string | null;
  reason: string | null;
}

/**
 * POST 결과를 받지 못한 경우에만 worker가 같은 AppOperationRun을 재시도한다.
 * requestId를 새로 만들면 중복 지급 가능성이 생기므로 오류 타입으로 구분한다.
 */
export class PlatformOperationUnknownOutcomeError extends Error {
  constructor(cause?: unknown) {
    super(
      "플랫폼 처리 결과를 확인하지 못했습니다. 같은 requestId로 재시도합니다.",
      { cause },
    );
    this.name = "PlatformOperationUnknownOutcomeError";
  }
}

function stringParam(
  params: Record<string, string | number | boolean>,
  key: string,
): string {
  const value = params[key];
  if (typeof value !== "string") {
    throw new Error(`플랫폼 오퍼레이션 ${key} 값이 올바르지 않습니다.`);
  }
  return value;
}

function confirmedBooleanParam(
  params: Record<string, string | number | boolean>,
  key: string,
): true {
  if (params[key] !== true) {
    throw new Error(`플랫폼 오퍼레이션 ${key} 확인이 필요합니다.`);
  }
  return true;
}

function isUnknownOutcome(error: unknown): boolean {
  if (error instanceof PlatformOperationUnknownOutcomeError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; code?: unknown };
  if (candidate.code === "platform_response_invalid") return true;
  return (
    candidate.status === 0 ||
    candidate.status === 408 ||
    candidate.status === 425 ||
    candidate.status === 429 ||
    (typeof candidate.status === "number" && candidate.status >= 500)
  );
}

function validateResult(result: PlatformOperatorResult): void {
  if (
    typeof result?.applied !== "boolean" ||
    !Array.isArray(result.entitlements) ||
    result.entitlements.some((value) => typeof value !== "string")
  ) {
    throw new PlatformOperationUnknownOutcomeError();
  }
}

function validateSandboxResetResult(
  result: PlatformSandboxResetResult,
): void {
  if (
    typeof result?.platformUserId !== "string" ||
    !Array.isArray(result.resetOrderKeys) ||
    result.resetOrderKeys.some((value) => typeof value !== "string")
  ) {
    throw new PlatformOperationUnknownOutcomeError();
  }
}

/** 중앙 플랫폼 write allowlist를 실행하고 식별자가 없는 최소 결과만 반환한다. */
export async function executePlatformOperation(
  input: PlatformOperationExecutionInput,
  clientFactory: PlatformOperationsClientFactory =
    createPlatformWriteOperationsClient,
): Promise<AppOpsResult> {
  const prepared = prepareQueuedPlatformOperation(input);
  const actor = input.actorLogin?.trim();
  if (!actor) {
    throw new Error("플랫폼 오퍼레이션 실행자 정보가 없습니다.");
  }

  const params = prepared.params;
  const client = await clientFactory();
  try {
    if (prepared.operationKey === "platform.iap.reset-app-store-sandbox") {
      const result = await client.resetAppStoreSandbox(
        {
          requestId: prepared.requestId,
          platformUserId: stringParam(params, "platformUserId"),
          reason: prepared.reason,
          appId: prepared.appSlug,
          expectedEnvironment: "sandbox",
          confirmation: stringParam(params, "serverConfirmation"),
          appleClearedConfirmed: confirmedBooleanParam(
            params,
            "appleClearedConfirmed",
          ),
        },
        actor,
      );
      validateSandboxResetResult(result);
      return {
        version: 1,
        requestId: prepared.requestId,
        operation: prepared.operationKey,
        status: "success",
        summary: "App Store Sandbox 원장 초기화를 처리했습니다.",
        data: { resetOrderCount: result.resetOrderKeys.length },
        completedAt: new Date().toISOString(),
      };
    }

    const request: PlatformOperatorRequest = {
      requestId: prepared.requestId,
      platformUserId: stringParam(params, "platformUserId"),
      entitlementId: stringParam(params, "entitlementId"),
      reason: prepared.reason,
      appId: prepared.appSlug,
      expectedEnvironment: stringParam(
        params,
        "expectedEnvironment",
      ) as PlatformOperatorRequest["expectedEnvironment"],
      confirmation: stringParam(params, "serverConfirmation"),
    };
    const result =
      prepared.operationKey === "platform.iap.grant-entitlement"
        ? await client.grantEntitlement(request, actor)
        : await client.revokeEntitlement(
            {
              ...request,
              grantRequestId: stringParam(params, "grantRequestId"),
            },
            actor,
          );
    validateResult(result);
    return {
      version: 1,
      requestId: prepared.requestId,
      operation: prepared.operationKey,
      status: "success",
      summary: result.applied
        ? "플랫폼 entitlement 변경을 처리했습니다."
        : "이미 처리된 동일 requestId입니다.",
      data: {
        applied: result.applied,
        activeEntitlementCount: result.entitlements.length,
      },
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (isUnknownOutcome(error)) {
      throw new PlatformOperationUnknownOutcomeError(error);
    }
    throw error;
  }
}

export const isPlatformUnknownOutcomeForTest = isUnknownOutcome;
