"use server";

import { revalidatePath } from "next/cache";

import { resumePreparedSandboxResetWhenPrepared } from "@/lib/actions/platform-ops-policy";
import type { AppOpsResult } from "@/lib/app-ops/operation";
import { env } from "@/lib/env";
import {
  getAppOperationRunStatus,
  listRecentAppOperationRuns,
  type AppOpsRunSummary,
} from "@/lib/app-ops/runs";
import {
  requirePlatformReadAccess,
  requirePlatformWriteAccess,
  PlatformAccessError,
} from "@/lib/platform/access";
import {
  PLATFORM_REPO_FULL_NAME,
  PlatformOperationInputError,
  preparePlatformOperation,
  type PlatformOperationKey,
} from "@/lib/platform/operations";
import type { PlatformUnknownReconciliationResolution } from "@/lib/platform/confirmation";
import {
  closeNotStartedSandboxResetOperation,
  enqueuePlatformOperation,
  PlatformBlockingOperationError,
  reconcileExpiredUnknownPlatformOperation,
  resumePreparedSandboxResetOperation,
  retryUnknownPlatformOperation,
  type PlatformSandboxResetRemoteState,
} from "@/lib/platform/runs";
import type { PlatformBlockingReference } from "@/lib/platform/recovery";
import { prisma } from "@/lib/prisma";
import { createPlatformReadClient } from "@/lib/platform/read-client";

interface PlatformOperationBaseInput {
  requestId: string;
  appSlug: string;
  platformUserId: string;
  reason: string;
  expectedEnvironment: "sandbox" | "production";
  serverConfirmation: string;
}

interface PlatformEntitlementOperationInput
  extends PlatformOperationBaseInput {
  entitlementId: string;
}

export interface GrantPlatformEntitlementInput
  extends PlatformEntitlementOperationInput {
  operation: "platform.iap.grant-entitlement";
}

export interface RevokePlatformEntitlementInput
  extends PlatformEntitlementOperationInput {
  operation: "platform.iap.revoke-entitlement";
  grantRequestId: string;
}

export interface ResetPlatformAppStoreSandboxInput
  extends PlatformOperationBaseInput {
  operation: "platform.iap.reset-app-store-sandbox";
  expectedEnvironment: "sandbox";
  appleClearedConfirmed: true;
}

export interface DecidePlatformRefundReviewInput {
  operation: "platform.iap.decide-refund-review";
  requestId: string;
  appSlug: string;
  reviewId: string;
  expectedEnvironment: "sandbox" | "production";
  refundPreference: "DECLINE" | "APPROVE" | "NEUTRAL";
  sampleContentProvided: boolean;
  reason:
    | "verified_fulfillment"
    | "customer_refund_supported"
    | "insufficient_evidence"
    | "internal_validation";
  serverConfirmation: string;
}

export type EnqueuePlatformOperationInput =
  | GrantPlatformEntitlementInput
  | RevokePlatformEntitlementInput
  | ResetPlatformAppStoreSandboxInput
  | DecidePlatformRefundReviewInput;

export interface EnqueuePlatformOperationResult {
  ok: boolean;
  requestId?: string;
  blockingReference?: PlatformBlockingReference;
  error?: string;
}

export interface PlatformOperationStatusResponse {
  ok: boolean;
  found?: boolean;
  status?: string;
  conclusion?: string | null;
  result?: AppOpsResult;
  resultError?: string;
  outcomeUnknown?: boolean;
  outcomeExpired?: boolean;
  sandboxResetState?: PlatformSandboxResetRemoteState;
  error?: string;
}

export interface RetryPlatformOperationResult {
  ok: boolean;
  error?: string;
}

export interface ReconcileExpiredUnknownPlatformOperationInput {
  appSlug: string;
  requestId: string;
  resolution: PlatformUnknownReconciliationResolution;
  confirmation: string;
}

export interface ResumePreparedSandboxResetInput {
  appSlug: string;
  requestId: string;
  confirmation: string;
}

export interface CloseNotStartedSandboxResetInput {
  appSlug: string;
  requestId: string;
  confirmation: string;
}

function publicActionError(error: unknown, fallback: string): string {
  if (
    error instanceof PlatformAccessError ||
    error instanceof PlatformOperationInputError
  ) {
    return error.message;
  }
  return fallback;
}

/** 고정 플랫폼 write 계약을 검증하고 기존 AppOperationRun 큐에 적재한다. */
export async function enqueuePlatformOperationAction(
  input: EnqueuePlatformOperationInput,
): Promise<EnqueuePlatformOperationResult> {
  try {
    // VIEWER와 비로그인 사용자는 기능 상태나 입력 검증 결과조차 받지 않는다.
    await requirePlatformReadAccess();
    if (!env.featurePlatformWrites()) {
      throw new PlatformAccessError(
        "플랫폼 변경 기능이 아직 활성화되지 않았습니다.",
      );
    }
    // 호출자가 네트워크 요청 전에 만든 ID만 허용한다. 서버가 뒤늦게 만든 ID는
    // 응답 유실 시 브라우저가 복구할 방법이 없다.
    const prepared = preparePlatformOperation(input);
    // 검증된 slug를 기준으로 DB User/AppOwner를 다시 확인한다.
    const actor = await requirePlatformWriteAccess(prepared.appSlug);

    // 권한을 확인한 app과 검증된 operation 대상이 같은지 명시적으로 묶는다.
    if (actor.appSlug !== prepared.appSlug) {
      throw new Error("권한을 확인한 앱과 플랫폼 요청 앱이 일치하지 않습니다.");
    }

    await enqueuePlatformOperation({
      appId: actor.appId,
      actorLogin: actor.login,
      prepared,
    });

    revalidatePath("/platform/iap");
    return { ok: true, requestId: prepared.requestId };
  } catch (error) {
    return {
      ok: false,
      blockingReference:
        error instanceof PlatformBlockingOperationError
          ? error.reference
          : undefined,
      error: publicActionError(
        error,
        "플랫폼 요청을 등록하지 못했습니다. request ID로 상태를 확인하세요.",
      ),
    };
  }
}

async function platformAppId(appSlug: string): Promise<string> {
  const app = await prisma.app.findUnique({
    where: { slug: appSlug },
    select: { id: true },
  });
  if (!app) throw new Error("플랫폼 앱 레지스트리에 연결된 앱을 찾을 수 없습니다.");
  return app.id;
}

async function sandboxResetRemoteState(
  appSlug: string,
  requestId: string,
): Promise<PlatformSandboxResetRemoteState> {
  const status = await createPlatformReadClient().sandboxResetStatus(
    requestId,
    appSlug,
  );
  return status?.state ?? "absent";
}

export async function getPlatformOperationStatusAction(
  appSlug: string,
  requestId: string,
): Promise<PlatformOperationStatusResponse> {
  try {
    await requirePlatformReadAccess();
    const appId = await platformAppId(appSlug);
    const run = await getAppOperationRunStatus(
      appId,
      requestId,
      PLATFORM_REPO_FULL_NAME,
    );
    if (!run) return { ok: true, found: false, status: "waiting" };
    const sandboxResetState =
      run.operation === "platform.iap.reset-app-store-sandbox" &&
      run.outcomeExpired
        ? await sandboxResetRemoteState(appSlug, requestId)
        : undefined;
    return {
      ok: true,
      found: true,
      status: run.status,
      conclusion: run.conclusion,
      result: run.result,
      resultError: run.resultError,
      outcomeUnknown: run.outcomeUnknown,
      outcomeExpired: run.outcomeExpired,
      sandboxResetState,
    };
  } catch (error) {
    return {
      ok: false,
      error: publicActionError(error, "실행 상태를 조회하지 못했습니다."),
    };
  }
}

/** 결과 불명으로 끝난 기존 row를 새 ID 없이 다시 worker에 넘긴다. */
export async function retryUnknownPlatformOperationAction(
  appSlug: string,
  requestId: string,
): Promise<RetryPlatformOperationResult> {
  try {
    await requirePlatformReadAccess();
    if (!env.featurePlatformWrites()) {
      throw new PlatformAccessError(
        "플랫폼 변경 기능이 아직 활성화되지 않았습니다.",
      );
    }
    const actor = await requirePlatformWriteAccess(appSlug);
    await retryUnknownPlatformOperation({
      appId: actor.appId,
      appSlug: actor.appSlug,
      actorLogin: actor.login,
      requestId,
    });
    revalidatePath("/platform/iap");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: publicActionError(
        error,
        "동일 request ID 재실행을 등록하지 못했습니다.",
      ),
    };
  }
}

/** 원장 대조가 끝난 만료 unknown만 감사 로그와 함께 비차단 상태로 닫는다. */
export async function reconcileExpiredUnknownPlatformOperationAction(
  input: ReconcileExpiredUnknownPlatformOperationInput,
): Promise<RetryPlatformOperationResult> {
  try {
    await requirePlatformReadAccess();
    if (!env.featurePlatformWrites()) {
      throw new PlatformAccessError(
        "플랫폼 변경 기능이 아직 활성화되지 않았습니다.",
      );
    }
    const actor = await requirePlatformWriteAccess(input.appSlug);
    const run = await getAppOperationRunStatus(
      actor.appId,
      input.requestId,
      PLATFORM_REPO_FULL_NAME,
    );
    if (!run?.outcomeExpired) {
      throw new PlatformOperationInputError(
        "대조 종료할 수 있는 만료된 결과 미확인 요청이 아닙니다.",
      );
    }
    const resetState =
      run.operation === "platform.iap.reset-app-store-sandbox"
        ? await sandboxResetRemoteState(actor.appSlug, input.requestId)
        : undefined;
    await reconcileExpiredUnknownPlatformOperation({
      appId: actor.appId,
      appSlug: actor.appSlug,
      actorLogin: actor.login,
      requestId: input.requestId,
      resolution: input.resolution,
      confirmation: input.confirmation,
      sandboxResetState: resetState,
    });
    revalidatePath("/platform/iap");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: publicActionError(
        error,
        "결과 미확인 요청을 대조 종료하지 못했습니다.",
      ),
    };
  }
}

/** prepared durable reset intent를 write worker에서 같은 requestId로 재개한다. */
export async function resumePreparedSandboxResetAction(
  input: ResumePreparedSandboxResetInput,
): Promise<RetryPlatformOperationResult> {
  try {
    await requirePlatformReadAccess();
    if (!env.featurePlatformWrites()) {
      throw new PlatformAccessError(
        "플랫폼 변경 기능이 아직 활성화되지 않았습니다.",
      );
    }
    const actor = await requirePlatformWriteAccess(input.appSlug);
    const run = await getAppOperationRunStatus(
      actor.appId,
      input.requestId,
      PLATFORM_REPO_FULL_NAME,
    );
    if (
      !run?.outcomeExpired ||
      run.operation !== "platform.iap.reset-app-store-sandbox"
    ) {
      throw new PlatformOperationInputError(
        "재개할 수 있는 만료된 sandbox reset 요청이 아닙니다.",
      );
    }
    const remoteState = await sandboxResetRemoteState(
      actor.appSlug,
      input.requestId,
    );
    await resumePreparedSandboxResetWhenPrepared(remoteState, () =>
      resumePreparedSandboxResetOperation({
        appId: actor.appId,
        appSlug: actor.appSlug,
        actorLogin: actor.login,
        requestId: input.requestId,
        confirmation: input.confirmation,
      }),
    );
    revalidatePath("/platform/iap");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: publicActionError(
        error,
        "대기 중인 sandbox reset을 재개하지 못했습니다.",
      ),
    };
  }
}

/** absent 조회를 local 판정으로 닫지 않고 write worker의 permanent closure로 넘긴다. */
export async function closeNotStartedSandboxResetAction(
  input: CloseNotStartedSandboxResetInput,
): Promise<RetryPlatformOperationResult> {
  try {
    await requirePlatformReadAccess();
    if (!env.featurePlatformWrites()) {
      throw new PlatformAccessError(
        "플랫폼 변경 기능이 아직 활성화되지 않았습니다.",
      );
    }
    const actor = await requirePlatformWriteAccess(input.appSlug);
    const run = await getAppOperationRunStatus(
      actor.appId,
      input.requestId,
      PLATFORM_REPO_FULL_NAME,
    );
    if (
      !run?.outcomeExpired ||
      run.operation !== "platform.iap.reset-app-store-sandbox"
    ) {
      throw new PlatformOperationInputError(
        "미시작 종료할 수 있는 만료된 sandbox reset 요청이 아닙니다.",
      );
    }
    const remoteState = await sandboxResetRemoteState(
      actor.appSlug,
      input.requestId,
    );
    if (remoteState === "prepared") {
      throw new PlatformOperationInputError(
        "sandbox reset이 이미 prepared 상태입니다. 동일 request ID로 재개하세요.",
      );
    }
    if (remoteState === "completed") {
      throw new PlatformOperationInputError(
        "sandbox reset이 이미 완료됐습니다. 플랫폼 적용 확인으로 대조 종료하세요.",
      );
    }
    if (remoteState === "closed_not_started") {
      throw new PlatformOperationInputError(
        "sandbox reset 미시작 종료가 이미 확정됐습니다. 플랫폼 미적용 확인으로 대조 종료하세요.",
      );
    }
    await closeNotStartedSandboxResetOperation({
      appId: actor.appId,
      appSlug: actor.appSlug,
      actorLogin: actor.login,
      requestId: input.requestId,
      confirmation: input.confirmation,
    });
    revalidatePath("/platform/iap");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: publicActionError(
        error,
        "sandbox reset 미시작 종료를 등록하지 못했습니다.",
      ),
    };
  }
}

export async function listPlatformOperationRunsAction(
  appSlug: string,
): Promise<{ ok: boolean; runs?: AppOpsRunSummary[]; error?: string }> {
  try {
    await requirePlatformReadAccess();
    const appId = await platformAppId(appSlug);
    return {
      ok: true,
      runs: await listRecentAppOperationRuns(
        appId,
        10,
        PLATFORM_REPO_FULL_NAME,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error: publicActionError(error, "실행 이력을 조회하지 못했습니다."),
    };
  }
}

// UI가 operation 문자열 union만 별도 import할 때 사용할 수 있게 유지한다.
export type { PlatformOperationKey };
