"use server";

import { revalidatePath } from "next/cache";

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
import {
  enqueuePlatformOperation,
  retryUnknownPlatformOperation,
} from "@/lib/platform/runs";
import { prisma } from "@/lib/prisma";

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

export type EnqueuePlatformOperationInput =
  | GrantPlatformEntitlementInput
  | RevokePlatformEntitlementInput
  | ResetPlatformAppStoreSandboxInput;

export interface EnqueuePlatformOperationResult {
  ok: boolean;
  requestId?: string;
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
  error?: string;
}

export interface RetryPlatformOperationResult {
  ok: boolean;
  error?: string;
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
    return {
      ok: true,
      found: true,
      status: run.status,
      conclusion: run.conclusion,
      result: run.result,
      resultError: run.resultError,
      outcomeUnknown: run.outcomeUnknown,
      outcomeExpired: run.outcomeExpired,
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
