import {
  AppOperationRunStatus,
  Prisma,
  type AppOperationRun,
} from "@prisma/client";

import {
  executeLizardTycoonOperation,
  requireLizardOperationIntent,
} from "@/lib/app-ops/adapters/lizard-tycoon";
import { shouldUsePlatform } from "@/lib/app-ops/adapters/lizard-tycoon-platform";
import {
  appOpsResultSchema,
  type AppOperationValues,
  type AppOpsResult,
} from "@/lib/app-ops/operation";
import {
  executePlatformOperation,
  PlatformOperationUnknownOutcomeError,
} from "@/lib/platform/executor";
import {
  PLATFORM_OUTCOME_UNKNOWN_CODE,
  PLATFORM_REPO_FULL_NAME,
  prepareQueuedPlatformOperation,
} from "@/lib/platform/operations";
import {
  revalidateQueuedPlatformReadAccess,
  revalidateQueuedPlatformWriteAccess,
} from "@/lib/platform/access";
import { prisma } from "@/lib/prisma";

const MAX_ATTEMPTS = 3;
const STALE_AFTER_MS = 10 * 60 * 1_000;
const LIZARD_TYCOON_REPO = "seorilabs/lizard-tycoon";
const LIZARD_TYCOON_APP_SLUG = "lizard-tycoon";

/**
 * 플랫폼 전환 플래그만 켜고 write identity를 빠뜨린 worker는 큐를 잡기 전에
 * 종료한다. legacy mutation 차단 후 중앙 호출도 못 하는 반쪽 배포를 막는다.
 */
export function assertPlatformWorkerConfiguration(input: {
  enabled: boolean;
  writeConfigured: boolean;
}): void {
  if (input.enabled && !input.writeConfigured) {
    throw new Error(
      "FEATURE_PLATFORM_ADMIN이 켜졌지만 플랫폼 write 설정이 없습니다.",
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeErrorMessage(
  error: unknown,
  sensitiveValues: readonly string[] = [],
): string {
  const message = error instanceof Error ? error.message : "알 수 없는 오류";
  let redacted = message;
  for (const value of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    if (value.length < 3) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED]");
  }
  return redacted
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[REDACTED]")
    .slice(0, 500);
}

function platformSensitiveValues(
  run: Pick<AppOperationRun, "repoFullName" | "params" | "reason">,
): string[] {
  if (
    run.repoFullName !== PLATFORM_REPO_FULL_NAME ||
    !run.params ||
    typeof run.params !== "object" ||
    Array.isArray(run.params)
  ) {
    return run.repoFullName === PLATFORM_REPO_FULL_NAME && run.reason
      ? [run.reason]
      : [];
  }
  const params = run.params as Record<string, unknown>;
  return [
    params.platformUserId,
    params.entitlementId,
    params.serverConfirmation,
    run.reason,
  ].filter((value): value is string => typeof value === "string" && value !== "");
}

function completionRedaction(repoFullName: string) {
  return {
    params: Prisma.DbNull,
    ...(repoFullName === PLATFORM_REPO_FULL_NAME ? { reason: null } : {}),
  };
}

function shouldRetryPlatformUnknownOutcome(input: {
  repoFullName: string;
  attempts: number;
  error: unknown;
}): boolean {
  return (
    input.repoFullName === PLATFORM_REPO_FULL_NAME &&
    input.error instanceof PlatformOperationUnknownOutcomeError &&
    input.attempts < MAX_ATTEMPTS
  );
}

function hadPlatformUnknownOutcome(input: {
  repoFullName: string;
  error: string | null;
}): boolean {
  return (
    input.repoFullName === PLATFORM_REPO_FULL_NAME &&
    input.error === PLATFORM_OUTCOME_UNKNOWN_CODE
  );
}

/**
 * PROCESSING에서 worker가 사라진 시점은 원격 호출 전후를 구분할 수 없다.
 * 중앙 플랫폼 row는 시도 횟수와 무관하게 동일-ID unknown 복구 상태를 유지한다.
 */
function staleRecoveryUpdate(
  run: Pick<AppOperationRun, "attempts" | "repoFullName">,
  now: Date,
) {
  const platformOutcomeUnknown =
    run.repoFullName === PLATFORM_REPO_FULL_NAME;
  if (run.attempts >= MAX_ATTEMPTS) {
    return {
      status: AppOperationRunStatus.FAILED,
      summary: platformOutcomeUnknown
        ? "플랫폼 호출 중 worker가 중단되어 적용 결과를 확인하지 못했습니다."
        : "worker 재시도 한도를 초과했습니다.",
      error: platformOutcomeUnknown
        ? PLATFORM_OUTCOME_UNKNOWN_CODE
        : "worker timeout",
      completedAt: now,
      // 플랫폼 PROCESSING 중단은 원격 적용 뒤였을 수 있다. TTL까지 원 요청을
      // 보존해 새 ID가 아니라 같은 ID 수동 retry만 허용한다.
      ...(platformOutcomeUnknown
        ? {}
        : completionRedaction(run.repoFullName)),
    };
  }

  return {
    status: AppOperationRunStatus.PENDING,
    startedAt: null,
    ...(platformOutcomeUnknown
      ? {
          summary: "플랫폼 처리 결과 불명 · 동일 requestId 재시도 대기",
          error: PLATFORM_OUTCOME_UNKNOWN_CODE,
        }
      : {}),
  };
}

export async function executeAppOperation(
  run: AppOperationRun,
): Promise<AppOpsResult> {
  if (run.repoFullName === PLATFORM_REPO_FULL_NAME) {
    return executePlatformOperation(platformOperationInputForTest(run));
  }

  if (run.repoFullName === LIZARD_TYCOON_REPO) {
    return executeLizardTycoonOperation(lizardOperationInputForTest(run));
  }
  throw new Error(`등록되지 않은 Kubernetes AppOps adapter: ${run.repoFullName}`);
}

export function platformOperationInputForTest(
  run: Pick<
    AppOperationRun,
    "requestId" | "operation" | "params" | "actorLogin" | "reason"
  >,
) {
  return {
    requestId: run.requestId,
    operation: run.operation,
    params: run.params,
    actorLogin: run.actorLogin,
    reason: run.reason,
  };
}

export function lizardOperationInputForTest(
  run: Pick<
    AppOperationRun,
    "requestId" | "operation" | "intent" | "params" | "actorLogin" | "reason"
  >,
) {
  const params =
    run.params && typeof run.params === "object" && !Array.isArray(run.params)
      ? (run.params as AppOperationValues)
      : {};
  return {
    requestId: run.requestId,
    operation: run.operation,
    intent: run.intent,
    params,
    actorLogin: run.actorLogin,
    reason: run.reason ?? "",
  };
}

export async function recoverStaleAppOperations(now = new Date()): Promise<void> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
  const stale = await prisma.appOperationRun.findMany({
    where: {
      status: AppOperationRunStatus.PROCESSING,
      startedAt: { lt: staleBefore },
    },
    select: { id: true, attempts: true, repoFullName: true },
  });
  for (const run of stale) {
    await prisma.appOperationRun.updateMany({
      where: {
        id: run.id,
        status: AppOperationRunStatus.PROCESSING,
      },
      data: staleRecoveryUpdate(run, now),
    });
  }
}

function expiredPendingUpdate(outcomeUnknown: boolean, now: Date) {
  return {
    status: AppOperationRunStatus.FAILED,
    summary: outcomeUnknown
      ? "플랫폼 결과 미확인 요청의 재시도 기한이 만료됐습니다."
      : "플랫폼 오퍼레이션 보관 기간이 만료됐습니다.",
    // 원격 적용 가능성이 있는 row는 payload를 지운 뒤에도 machine marker를
    // 보존한다. 그래야 새 request ID를 막고 수동 원장 대조로만 닫을 수 있다.
    error: outcomeUnknown
      ? PLATFORM_OUTCOME_UNKNOWN_CODE
      : "operation expired",
    completedAt: now,
    params: Prisma.DbNull,
    result: Prisma.DbNull,
    reason: null,
    redactedAt: now,
  };
}

export async function redactExpiredAppOperations(
  now = new Date(),
): Promise<number> {
  // worker가 장시간 멈춰도 중앙 플랫폼의 PUID/reason이 TTL을 넘어 큐에
  // 남지 않게 한다. PROCESSING은 실행 중 경쟁을 피하고 stale recovery 뒤 처리한다.
  const abandonedUnknown = await prisma.appOperationRun.updateMany({
    where: {
      repoFullName: PLATFORM_REPO_FULL_NAME,
      expiresAt: { lte: now },
      redactedAt: null,
      status: AppOperationRunStatus.PENDING,
      error: PLATFORM_OUTCOME_UNKNOWN_CODE,
    },
    data: expiredPendingUpdate(true, now),
  });
  const abandoned = await prisma.appOperationRun.updateMany({
    where: {
      repoFullName: PLATFORM_REPO_FULL_NAME,
      expiresAt: { lte: now },
      redactedAt: null,
      status: AppOperationRunStatus.PENDING,
    },
    data: expiredPendingUpdate(false, now),
  });
  const expired = await prisma.appOperationRun.findMany({
    where: {
      expiresAt: { lte: now },
      redactedAt: null,
      status: {
        in: [
          AppOperationRunStatus.SUCCEEDED,
          AppOperationRunStatus.FAILED,
        ],
      },
    },
    select: { id: true },
    take: 100,
  });
  if (expired.length === 0) {
    return abandonedUnknown.count + abandoned.count;
  }
  const updated = await prisma.appOperationRun.updateMany({
    where: { id: { in: expired.map(({ id }) => id) } },
    data: {
      params: Prisma.DbNull,
      result: Prisma.DbNull,
      reason: null,
      redactedAt: now,
    },
  });
  return abandonedUnknown.count + abandoned.count + updated.count;
}

async function claimNextAppOperation(): Promise<AppOperationRun | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const startedAt = new Date();
    const candidate = await prisma.appOperationRun.findFirst({
      where: {
        status: AppOperationRunStatus.PENDING,
        attempts: { lt: MAX_ATTEMPTS },
        expiresAt: { gt: startedAt },
      },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) return null;
    const claimed = await prisma.appOperationRun.updateMany({
      where: {
        id: candidate.id,
        status: AppOperationRunStatus.PENDING,
        attempts: candidate.attempts,
        // 조회와 claim 사이에 만료돼도 write identity로 넘기지 않는다.
        expiresAt: { gt: startedAt },
      },
      data: {
        status: AppOperationRunStatus.PROCESSING,
        attempts: { increment: 1 },
        startedAt,
        // 이전 원격 결과가 불명확했던 동일-ID retry 표식은 실행 전 권한
        // 재검증이나 mutable precondition이 실패해도 잃지 않는다.
        error:
          candidate.error === PLATFORM_OUTCOME_UNKNOWN_CODE
            ? PLATFORM_OUTCOME_UNKNOWN_CODE
            : null,
      },
    });
    if (claimed.count === 1) {
      return prisma.appOperationRun.findUnique({
        where: { id: candidate.id },
      });
    }
  }
  return null;
}

export async function processNextAppOperation(): Promise<boolean> {
  const run = await claimNextAppOperation();
  if (!run) return false;

  const hadUnknownOutcome = hadPlatformUnknownOutcome(run);
  let platformRemoteCompleted = false;
  try {
    let executableRun = run;
    if (run.repoFullName === PLATFORM_REPO_FULL_NAME) {
      const prepared = prepareQueuedPlatformOperation({
        requestId: run.requestId,
        operation: run.operation,
        params: run.params,
        reason: run.reason,
      });
      const actor = await revalidateQueuedPlatformWriteAccess({
        appId: run.appId,
        appSlug: prepared.appSlug,
        actorLogin: run.actorLogin,
      });
      // 큐 문자열 대신 현재 DB의 canonical login을 외부 감사 헤더로 쓴다.
      executableRun = { ...run, actorLogin: actor.login };
    } else if (
      run.repoFullName === LIZARD_TYCOON_REPO &&
      shouldUsePlatform(run.operation)
    ) {
      // legacy 앱 화면의 platform-backed read도 큐 row를 권한 증명으로
      // 믿지 않는다. operation allowlist에서 read intent를 도출한다.
      requireLizardOperationIntent(run.operation, run.intent);
      const actor = await revalidateQueuedPlatformReadAccess({
        appId: run.appId,
        appSlug: LIZARD_TYCOON_APP_SLUG,
        actorLogin: run.actorLogin,
      });
      executableRun = { ...run, actorLogin: actor.login };
    }
    const rawResult = await executeAppOperation(executableRun);
    // API가 성공 응답을 준 뒤 DB 완료 저장만 실패해도 새 requestId를 허용하면
    // 중복 지급이 생긴다. 이 시점 이후 오류는 결과 불명으로 수렴한다.
    platformRemoteCompleted =
      run.repoFullName === PLATFORM_REPO_FULL_NAME;
    const result = appOpsResultSchema.parse(rawResult);
    await prisma.appOperationRun.update({
      where: { id: run.id },
      data: {
        status: AppOperationRunStatus.SUCCEEDED,
        summary: result.summary,
        result: result as Prisma.InputJsonValue,
        error: null,
        completedAt: new Date(),
        ...completionRedaction(run.repoFullName),
      },
    });
  } catch (error) {
    const effectiveError =
      platformRemoteCompleted &&
      !(error instanceof PlatformOperationUnknownOutcomeError)
        ? new PlatformOperationUnknownOutcomeError()
        : hadUnknownOutcome &&
            !(error instanceof PlatformOperationUnknownOutcomeError)
          ? new PlatformOperationUnknownOutcomeError()
          : error;
    const summary = safeErrorMessage(
      effectiveError,
      platformSensitiveValues(run),
    );
    if (shouldRetryPlatformUnknownOutcome({ ...run, error: effectiveError })) {
      // 같은 row를 PENDING으로 돌린다. 새 requestId를 만들지 않아 플랫폼의
      // 멱등 원장과 한 요청으로 이어진다. 실행 입력은 최종 완료 전까지 유지한다.
      await prisma.appOperationRun.update({
        where: { id: run.id },
        data: {
          status: AppOperationRunStatus.PENDING,
          summary: "플랫폼 처리 결과 불명 · 동일 requestId 재시도 대기",
          error: PLATFORM_OUTCOME_UNKNOWN_CODE,
          startedAt: null,
          completedAt: null,
        },
      });
      return true;
    }
    const terminalSummary =
      effectiveError instanceof PlatformOperationUnknownOutcomeError
        ? "플랫폼 처리 결과를 확인하지 못했고 재시도 한도를 초과했습니다."
        : summary;
    const outcomeUnknown =
      effectiveError instanceof PlatformOperationUnknownOutcomeError;
    const result: AppOpsResult = {
      version: 1,
      requestId: run.requestId,
      operation: run.operation,
      status: "error",
      summary: terminalSummary,
      completedAt: new Date().toISOString(),
    };
    await prisma.appOperationRun.update({
      where: { id: run.id },
      data: {
        status: AppOperationRunStatus.FAILED,
        summary: terminalSummary,
        result: result as Prisma.InputJsonValue,
        // 결과 불명은 일반 실패와 구분한다. params/reason을 TTL까지 남겨
        // 승인된 운영자가 같은 requestId로만 다시 보낼 수 있게 한다.
        error: outcomeUnknown
          ? PLATFORM_OUTCOME_UNKNOWN_CODE
          : terminalSummary,
        completedAt: new Date(),
        ...(outcomeUnknown ? {} : completionRedaction(run.repoFullName)),
      },
    });
  }
  return true;
}

export const safeAppOpsErrorForTest = safeErrorMessage;
export const platformSensitiveValuesForTest = platformSensitiveValues;
export const completionRedactionForTest = completionRedaction;
export const shouldRetryPlatformUnknownOutcomeForTest =
  shouldRetryPlatformUnknownOutcome;
export const hadPlatformUnknownOutcomeForTest = hadPlatformUnknownOutcome;
export const staleRecoveryUpdateForTest = staleRecoveryUpdate;
export const expiredPendingUpdateForTest = expiredPendingUpdate;
