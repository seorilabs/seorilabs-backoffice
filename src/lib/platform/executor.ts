import type { AppOpsResult } from "@/lib/app-ops/operation";
import {
  prepareQueuedPlatformOperation,
  prepareQueuedSandboxResetClose,
  prepareQueuedSandboxResetResume,
} from "@/lib/platform/operations";
import type { PlatformOperationReason } from "@/lib/platform/reasons";
import type {
  PlatformRefundReviewDecisionReason,
  PlatformRefundReviewDecisionState,
  PlatformRefundReviewPreference,
} from "@/lib/platform/refund-review";

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

interface PlatformOperatorResultBase {
  applied: boolean;
  entitlements: string[];
  requestId: string;
  appId: string;
  platformUserId: string;
  entitlementId: string;
  expectedEnvironment: "sandbox" | "production";
}

export interface PlatformGrantOperatorResult
  extends PlatformOperatorResultBase {
  operation: "grant";
  grantRequestId?: never;
}

export interface PlatformRevokeOperatorResult
  extends PlatformOperatorResultBase {
  operation: "revoke";
  grantRequestId: string;
}

export type PlatformOperatorResult =
  | PlatformGrantOperatorResult
  | PlatformRevokeOperatorResult;

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
  requestId: string;
  appId: string;
  platformUserId: string;
  expectedEnvironment: "sandbox";
  operation: "sandbox_reset";
  resetOrderKeys: string[];
}

export interface PlatformSandboxResetResumeRequest {
  requestId: string;
  appId: string;
  confirmation: string;
}

export interface PlatformSandboxResetCloseRequest {
  requestId: string;
  appId: string;
  confirmation: string;
}

export interface PlatformSandboxResetCloseResult {
  requestId: string;
  appId: string;
  state: "closed_not_started";
  expectedEnvironment: "sandbox";
  operation: "sandbox_reset";
  applied: boolean;
}

export interface PlatformRefundReviewDecisionRequest {
  requestId: string;
  appId: string;
  reviewId: string;
  expectedEnvironment: "sandbox" | "production";
  refundPreference: PlatformRefundReviewPreference;
  sampleContentProvided: boolean;
  reason: PlatformRefundReviewDecisionReason;
  confirmation: string;
}

export interface PlatformRefundReviewDecisionResult {
  applied: boolean;
  requestId: string;
  appId: string;
  reviewId: string;
  expectedEnvironment: "sandbox" | "production";
  state: PlatformRefundReviewDecisionState;
  refundPreference: PlatformRefundReviewPreference;
  sampleContentProvided: boolean;
  operation: "refund_review_decision";
}

/** executor가 소비하는 최소 client 포트. 실제 client 클래스에 의존하지 않는다. */
export interface PlatformOperationsClient {
  grantEntitlement(
    request: PlatformOperatorRequest,
    actor: string,
  ): Promise<PlatformGrantOperatorResult>;
  revokeEntitlement(
    request: PlatformRevokeOperatorRequest,
    actor: string,
  ): Promise<PlatformRevokeOperatorResult>;
  resetAppStoreSandbox(
    request: PlatformSandboxResetRequest,
    actor: string,
  ): Promise<PlatformSandboxResetResult>;
  resumeSandboxReset(
    request: PlatformSandboxResetResumeRequest,
    actor: string,
  ): Promise<PlatformSandboxResetResult>;
  closeSandboxResetNotStarted(
    request: PlatformSandboxResetCloseRequest,
    actor: string,
  ): Promise<PlatformSandboxResetCloseResult>;
  decideRefundReview?(
    request: PlatformRefundReviewDecisionRequest,
    actor: string,
  ): Promise<PlatformRefundReviewDecisionResult>;
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

function booleanParam(
  params: Record<string, string | number | boolean>,
  key: string,
): boolean {
  const value = params[key];
  if (typeof value !== "boolean") {
    throw new Error(`플랫폼 오퍼레이션 ${key} 값이 올바르지 않습니다.`);
  }
  return value;
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
    (typeof candidate.status === "number" && candidate.status >= 500)
  );
}

function validateResult(
  result: PlatformOperatorResult,
  expected: PlatformOperatorRequest | PlatformRevokeOperatorRequest,
  operation: "grant" | "revoke",
): void {
  const expectedGrantRequestId =
    operation === "revoke"
      ? (expected as PlatformRevokeOperatorRequest).grantRequestId
      : undefined;
  if (
    typeof result?.applied !== "boolean" ||
    !Array.isArray(result.entitlements) ||
    result.entitlements.some((value) => typeof value !== "string") ||
    result.requestId !== expected.requestId ||
    result.appId !== expected.appId ||
    result.platformUserId !== expected.platformUserId ||
    result.entitlementId !== expected.entitlementId ||
    result.expectedEnvironment !== expected.expectedEnvironment ||
    result.operation !== operation ||
    result.grantRequestId !== expectedGrantRequestId
  ) {
    throw new PlatformOperationUnknownOutcomeError();
  }
}

function validateSandboxResetResult(
  result: PlatformSandboxResetResult,
  expected: PlatformSandboxResetRequest,
): void {
  if (
    result?.requestId !== expected.requestId ||
    result.appId !== expected.appId ||
    result.platformUserId !== expected.platformUserId ||
    result.expectedEnvironment !== expected.expectedEnvironment ||
    result.operation !== "sandbox_reset" ||
    !Array.isArray(result.resetOrderKeys) ||
    result.resetOrderKeys.some((value) => typeof value !== "string")
  ) {
    throw new PlatformOperationUnknownOutcomeError();
  }
}

function validateSandboxResetResumeResult(
  result: PlatformSandboxResetResult,
  expected: PlatformSandboxResetResumeRequest,
): void {
  if (
    result?.requestId !== expected.requestId ||
    result.appId !== expected.appId ||
    typeof result.platformUserId !== "string" ||
    result.platformUserId === "" ||
    result.expectedEnvironment !== "sandbox" ||
    result.operation !== "sandbox_reset" ||
    !Array.isArray(result.resetOrderKeys) ||
    result.resetOrderKeys.some((value) => typeof value !== "string")
  ) {
    throw new PlatformOperationUnknownOutcomeError();
  }
}

function validateSandboxResetCloseResult(
  result: PlatformSandboxResetCloseResult,
  expected: PlatformSandboxResetCloseRequest,
): void {
  if (
    result?.requestId !== expected.requestId ||
    result.appId !== expected.appId ||
    result.state !== "closed_not_started" ||
    result.expectedEnvironment !== "sandbox" ||
    result.operation !== "sandbox_reset" ||
    typeof result.applied !== "boolean"
  ) {
    throw new PlatformOperationUnknownOutcomeError();
  }
}

function validateRefundReviewDecisionResult(
  result: PlatformRefundReviewDecisionResult,
  expected: PlatformRefundReviewDecisionRequest,
): void {
  if (
    typeof result?.applied !== "boolean" ||
    result.requestId !== expected.requestId ||
    result.appId !== expected.appId ||
    result.reviewId !== expected.reviewId ||
    result.expectedEnvironment !== expected.expectedEnvironment ||
    (result.state !== "decided" &&
      result.state !== "responded" &&
      result.state !== "expired" &&
      result.state !== "failed") ||
    result.refundPreference !== expected.refundPreference ||
    result.sampleContentProvided !== expected.sampleContentProvided ||
    result.operation !== "refund_review_decision"
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
  const preparedClose = prepareQueuedSandboxResetClose(input);
  const preparedResume = prepareQueuedSandboxResetResume(input);
  const prepared = preparedClose || preparedResume
    ? null
    : prepareQueuedPlatformOperation(input);
  const actor = input.actorLogin?.trim();
  if (!actor) {
    throw new Error("플랫폼 오퍼레이션 실행자 정보가 없습니다.");
  }

  const client = await clientFactory();
  try {
    if (preparedClose) {
      const request: PlatformSandboxResetCloseRequest = {
        requestId: preparedClose.requestId,
        appId: preparedClose.appSlug,
        confirmation: preparedClose.serverConfirmation,
      };
      const result = await client.closeSandboxResetNotStarted(request, actor);
      validateSandboxResetCloseResult(result, request);
      return {
        version: 1,
        requestId: preparedClose.requestId,
        operation: "platform.iap.reset-app-store-sandbox",
        status: "success",
        summary: "App Store Sandbox reset 미시작 종료를 영구 확정했습니다.",
        data: { closureApplied: result.applied },
        completedAt: new Date().toISOString(),
      };
    }
    if (preparedResume) {
      const request: PlatformSandboxResetResumeRequest = {
        requestId: preparedResume.requestId,
        appId: preparedResume.appSlug,
        confirmation: preparedResume.serverConfirmation,
      };
      const result = await client.resumeSandboxReset(request, actor);
      validateSandboxResetResumeResult(result, request);
      return {
        version: 1,
        requestId: preparedResume.requestId,
        operation: "platform.iap.reset-app-store-sandbox",
        status: "success",
        summary: "대기 중인 App Store Sandbox 원장 초기화를 재개했습니다.",
        data: { resetOrderCount: result.resetOrderKeys.length },
        completedAt: new Date().toISOString(),
      };
    }

    // preparedResume와 상호 배타적인 parser 결과다.
    if (!prepared) throw new Error("플랫폼 오퍼레이션을 준비하지 못했습니다.");
    const params = prepared.params;
    if (prepared.operationKey === "platform.iap.decide-refund-review") {
      if (!client.decideRefundReview) {
        throw new Error("환불 검토 write client가 준비되지 않았습니다.");
      }
      const request: PlatformRefundReviewDecisionRequest = {
        requestId: prepared.requestId,
        appId: prepared.appSlug,
        reviewId: stringParam(params, "reviewId"),
        expectedEnvironment: stringParam(
          params,
          "expectedEnvironment",
        ) as PlatformRefundReviewDecisionRequest["expectedEnvironment"],
        refundPreference: stringParam(
          params,
          "refundPreference",
        ) as PlatformRefundReviewPreference,
        sampleContentProvided: booleanParam(params, "sampleContentProvided"),
        reason: prepared.reason as PlatformRefundReviewDecisionReason,
        confirmation: stringParam(params, "serverConfirmation"),
      };
      const result = await client.decideRefundReview(request, actor);
      validateRefundReviewDecisionResult(result, request);
      return {
        version: 1,
        requestId: prepared.requestId,
        operation: prepared.operationKey,
        status: "success",
        summary: result.applied
          ? "Google Play 환불 검토 결정을 영구 확정했습니다."
          : "이미 처리된 동일 requestId입니다.",
        data: { applied: result.applied, state: result.state },
        completedAt: new Date().toISOString(),
      };
    }
    if (prepared.operationKey === "platform.iap.reset-app-store-sandbox") {
      const platformUserId = stringParam(params, "platformUserId");
      const request: PlatformSandboxResetRequest = {
          requestId: prepared.requestId,
          platformUserId,
          reason: prepared.reason as PlatformOperationReason,
          appId: prepared.appSlug,
          expectedEnvironment: "sandbox",
          confirmation: stringParam(params, "serverConfirmation"),
          appleClearedConfirmed: confirmedBooleanParam(
            params,
            "appleClearedConfirmed",
          ),
      };
      const result = await client.resetAppStoreSandbox(request, actor);
      validateSandboxResetResult(result, request);
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
      reason: prepared.reason as PlatformOperationReason,
      appId: prepared.appSlug,
      expectedEnvironment: stringParam(
        params,
        "expectedEnvironment",
      ) as PlatformOperatorRequest["expectedEnvironment"],
      confirmation: stringParam(params, "serverConfirmation"),
    };
    let result: PlatformOperatorResult;
    if (prepared.operationKey === "platform.iap.grant-entitlement") {
      result = await client.grantEntitlement(request, actor);
      validateResult(result, request, "grant");
    } else {
      const revokeRequest: PlatformRevokeOperatorRequest = {
        ...request,
        grantRequestId: stringParam(params, "grantRequestId"),
      };
      result = await client.revokeEntitlement(revokeRequest, actor);
      validateResult(result, revokeRequest, "revoke");
    }
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
