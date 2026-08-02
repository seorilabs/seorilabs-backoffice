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
  PLATFORM_MIN_EXECUTION_WINDOW_MS,
  PLATFORM_OUTCOME_UNKNOWN_CODE,
  PLATFORM_REPO_FULL_NAME,
  queuedPlatformOperationAppSlug,
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

type AppOperationClaim = Pick<
  AppOperationRun,
  "id" | "repoFullName" | "attempts" | "startedAt"
>;

function activeProcessingWhere(run: AppOperationClaim) {
  return {
    id: run.id,
    status: AppOperationRunStatus.PROCESSING,
    redactedAt: null,
    // stale recovery 뒤 새 worker가 같은 row를 claim하면 attempts와
    // startedAt이 모두 바뀐다. 이전 worker는 새 세대 row를 닫지 못한다.
    attempts: run.attempts,
    startedAt: run.startedAt,
  };
}

function completionWriteWhere(run: AppOperationClaim) {
  // 중앙 플랫폼만 TTL redaction과 경쟁한다. 기존 앱 adapter는 기존처럼 id
  // 기준 완료 저장을 유지해 stale recovery 동작을 바꾸지 않는다.
  return run.repoFullName === PLATFORM_REPO_FULL_NAME
    ? activeProcessingWhere(run)
    : { id: run.id };
}

function assertPlatformResultBinding(
  run: Pick<AppOperationRun, "repoFullName" | "requestId" | "operation">,
  result: AppOpsResult,
): void {
  if (
    run.repoFullName === PLATFORM_REPO_FULL_NAME &&
    (result.requestId !== run.requestId || result.operation !== run.operation)
  ) {
    // remote 호출은 성공했을 수 있으므로 일반 실패로 닫지 않는다. 같은 row를
    // unknown으로 유지해야 새 requestId 중복 지급과 조기 redaction을 막는다.
    throw new PlatformOperationUnknownOutcomeError();
  }
}

function claimExpiryThreshold(repoFullName: string, startedAt: Date): Date {
  return repoFullName === PLATFORM_REPO_FULL_NAME
    ? new Date(startedAt.getTime() + PLATFORM_MIN_EXECUTION_WINDOW_MS)
    : startedAt;
}

function canStartPlatformRemote(
  repoFullName: string,
  startedAt: Date,
  expiresAt: Date,
): boolean {
  if (repoFullName !== PLATFORM_REPO_FULL_NAME) return true;
  return expiresAt > claimExpiryThreshold(repoFullName, startedAt);
}

async function executeWithinClaimWindow<T>(
  repoFullName: string,
  startedAt: Date,
  expiresAt: Date,
  execute: () => Promise<T>,
): Promise<{ started: false } | { started: true; result: T }> {
  if (!canStartPlatformRemote(repoFullName, startedAt, expiresAt)) {
    return { started: false };
  }
  return { started: true, result: await execute() };
}

function staleRecoveryLiveGuard(repoFullName: string, now: Date) {
  return repoFullName === PLATFORM_REPO_FULL_NAME
    ? { expiresAt: { gt: now }, redactedAt: null }
    : {};
}

function staleRecoveryWhere(run: AppOperationClaim, now: Date) {
  return {
    id: run.id,
    status: AppOperationRunStatus.PROCESSING,
    ...(run.repoFullName === PLATFORM_REPO_FULL_NAME
      ? {
          ...staleRecoveryLiveGuard(run.repoFullName, now),
          attempts: run.attempts,
          startedAt: run.startedAt,
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
      OR: [
        {
          repoFullName: PLATFORM_REPO_FULL_NAME,
          ...staleRecoveryLiveGuard(PLATFORM_REPO_FULL_NAME, now),
        },
        { repoFullName: { not: PLATFORM_REPO_FULL_NAME } },
      ],
    },
    select: {
      id: true,
      attempts: true,
      repoFullName: true,
      startedAt: true,
    },
  });
  for (const run of stale) {
    await prisma.appOperationRun.updateMany({
      where: staleRecoveryWhere(run, now),
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

function expiredPlatformProcessingWhere(now: Date) {
  return {
    repoFullName: PLATFORM_REPO_FULL_NAME,
    expiresAt: { lte: now },
    redactedAt: null,
    status: AppOperationRunStatus.PROCESSING,
  };
}

function expiredTerminalRowsWhere(ids: readonly string[], now: Date) {
  return {
    id: { in: [...ids] },
    expiresAt: { lte: now },
    redactedAt: null,
    status: {
      in: [AppOperationRunStatus.SUCCEEDED, AppOperationRunStatus.FAILED],
    },
  };
}

export async function redactExpiredAppOperations(
  now = new Date(),
): Promise<number> {
  // worker가 장시간 멈춰도 중앙 플랫폼의 PUID/reason이 TTL을 넘어 큐에
  // 남지 않게 한다. 실행 중이라도 보관 상한이 우선이며 늦은 worker 완료는
  // claim generation CAS가 막는다.
  const processing = await prisma.appOperationRun.updateMany({
    where: expiredPlatformProcessingWhere(now),
    data: expiredPendingUpdate(true, now),
  });
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
    return processing.count + abandonedUnknown.count + abandoned.count;
  }
  const updated = await prisma.appOperationRun.updateMany({
    // findMany 뒤 unknown 수동 retry가 row를 PENDING으로 되열 수 있다.
    // terminal·expiry·redaction을 다시 CAS해 재시도 payload를 지우지 않는다.
    where: expiredTerminalRowsWhere(
      expired.map(({ id }) => id),
      now,
    ),
    data: {
      params: Prisma.DbNull,
      result: Prisma.DbNull,
      reason: null,
      redactedAt: now,
    },
  });
  return (
    processing.count +
    abandonedUnknown.count +
    abandoned.count +
    updated.count
  );
}

async function claimNextAppOperation(): Promise<AppOperationRun | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const startedAt = new Date();
    const platformExpiresAfter = claimExpiryThreshold(
      PLATFORM_REPO_FULL_NAME,
      startedAt,
    );
    const candidate = await prisma.appOperationRun.findFirst({
      where: {
        status: AppOperationRunStatus.PENDING,
        attempts: { lt: MAX_ATTEMPTS },
        redactedAt: null,
        OR: [
          {
            repoFullName: PLATFORM_REPO_FULL_NAME,
            expiresAt: { gt: platformExpiresAfter },
          },
          {
            repoFullName: { not: PLATFORM_REPO_FULL_NAME },
            expiresAt: { gt: startedAt },
          },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) return null;
    const expiresAfter = claimExpiryThreshold(
      candidate.repoFullName,
      startedAt,
    );
    const claimed = await prisma.appOperationRun.updateMany({
      where: {
        id: candidate.id,
        status: AppOperationRunStatus.PENDING,
        attempts: candidate.attempts,
        redactedAt: null,
        // 조회와 claim 사이에 만료돼도 write identity로 넘기지 않는다.
        expiresAt: { gt: expiresAfter },
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
      const appSlug = queuedPlatformOperationAppSlug({
        requestId: run.requestId,
        operation: run.operation,
        params: run.params,
        reason: run.reason,
      });
      const actor = await revalidateQueuedPlatformWriteAccess({
        appId: run.appId,
        appSlug,
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
    const remoteStartedAt = new Date();
    const execution = await executeWithinClaimWindow(
      run.repoFullName,
      remoteStartedAt,
      run.expiresAt,
      () => executeAppOperation(executableRun),
    );
    if (!execution.started) {
      if (run.expiresAt <= remoteStartedAt) {
        await prisma.appOperationRun.updateMany({
          where: activeProcessingWhere(run),
          // 이 worker 세대는 remote를 시작하지 않았으므로 최초 시도는
          // definite expiry다. 이전 unknown retry라면 그 표식은 보존한다.
          data: expiredPendingUpdate(hadUnknownOutcome, remoteStartedAt),
        });
      } else {
        await prisma.appOperationRun.updateMany({
          where: activeProcessingWhere(run),
          data: {
            status: AppOperationRunStatus.PENDING,
            attempts: { decrement: 1 },
            startedAt: null,
            summary: "플랫폼 실행 안전 시간 부족 · TTL 만료 대기",
            error: hadUnknownOutcome
              ? PLATFORM_OUTCOME_UNKNOWN_CODE
              : null,
          },
        });
      }
      return true;
    }
    const rawResult = execution.result;
    // API가 성공 응답을 준 뒤 DB 완료 저장만 실패해도 새 requestId를 허용하면
    // 중복 지급이 생긴다. 이 시점 이후 오류는 결과 불명으로 수렴한다.
    platformRemoteCompleted =
      run.repoFullName === PLATFORM_REPO_FULL_NAME;
    const result = appOpsResultSchema.parse(rawResult);
    assertPlatformResultBinding(run, result);
    const completed = await prisma.appOperationRun.updateMany({
      // TTL redaction이 PROCESSING을 먼저 닫았으면 늦은 성공 결과로 unknown
      // 표식을 되돌리지 않는다. 원장 대조만 그 잠금을 닫을 수 있다.
      where: completionWriteWhere(run),
      data: {
        status: AppOperationRunStatus.SUCCEEDED,
        summary: result.summary,
        result: result as Prisma.InputJsonValue,
        error: null,
        completedAt: new Date(),
        ...completionRedaction(run.repoFullName),
      },
    });
    if (completed.count !== 1) {
      // 만료 정리가 먼저 FAILED/unknown + redactedAt을 기록한 정상 race다.
      // 늦은 응답은 보존하지 않고 수동 원장 대조 상태를 그대로 둔다.
      return true;
    }
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
      const retryAt = new Date();
      const retried = await prisma.appOperationRun.updateMany({
        where: {
          ...activeProcessingWhere(run),
          // 최초 enqueue의 보관 상한을 지난 row를 다시 PENDING으로 열지 않는다.
          expiresAt: { gt: retryAt },
        },
        data: {
          status: AppOperationRunStatus.PENDING,
          summary: "플랫폼 처리 결과 불명 · 동일 requestId 재시도 대기",
          error: PLATFORM_OUTCOME_UNKNOWN_CODE,
          startedAt: null,
          completedAt: null,
        },
      });
      if (retried.count !== 1 && run.repoFullName === PLATFORM_REPO_FULL_NAME) {
        await prisma.appOperationRun.updateMany({
          where: {
            ...activeProcessingWhere(run),
            expiresAt: { lte: retryAt },
          },
          data: expiredPendingUpdate(true, retryAt),
        });
      }
      return true;
    }
    const terminalSummary =
      effectiveError instanceof PlatformOperationUnknownOutcomeError
        ? "플랫폼 처리 결과를 확인하지 못했고 재시도 한도를 초과했습니다."
        : summary;
    const outcomeUnknown =
      effectiveError instanceof PlatformOperationUnknownOutcomeError;
    const completedAt = new Date();
    if (
      run.repoFullName === PLATFORM_REPO_FULL_NAME &&
      outcomeUnknown &&
      run.expiresAt <= completedAt
    ) {
      await prisma.appOperationRun.updateMany({
        where: {
          ...activeProcessingWhere(run),
          expiresAt: { lte: completedAt },
        },
        data: expiredPendingUpdate(true, completedAt),
      });
      return true;
    }
    const result: AppOpsResult = {
      version: 1,
      requestId: run.requestId,
      operation: run.operation,
      status: "error",
      summary: terminalSummary,
      completedAt: completedAt.toISOString(),
    };
    await prisma.appOperationRun.updateMany({
      where: completionWriteWhere(run),
      data: {
        status: AppOperationRunStatus.FAILED,
        summary: terminalSummary,
        result: result as Prisma.InputJsonValue,
        // 결과 불명은 일반 실패와 구분한다. params/reason을 TTL까지 남겨
        // 승인된 운영자가 같은 requestId로만 다시 보낼 수 있게 한다.
        error: outcomeUnknown
          ? PLATFORM_OUTCOME_UNKNOWN_CODE
          : terminalSummary,
        completedAt,
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
export const expiredPlatformProcessingWhereForTest =
  expiredPlatformProcessingWhere;
export const expiredTerminalRowsWhereForTest = expiredTerminalRowsWhere;
export const activeProcessingWhereForTest = activeProcessingWhere;
export const completionWriteWhereForTest = completionWriteWhere;
export const assertPlatformResultBindingForTest = assertPlatformResultBinding;
export const claimExpiryThresholdForTest = claimExpiryThreshold;
export const canStartPlatformRemoteForTest = canStartPlatformRemote;
export const executeWithinClaimWindowForTest = executeWithinClaimWindow;
export const staleRecoveryLiveGuardForTest = staleRecoveryLiveGuard;
export const staleRecoveryWhereForTest = staleRecoveryWhere;
export const PLATFORM_MIN_EXECUTION_WINDOW_MS_FOR_TEST =
  PLATFORM_MIN_EXECUTION_WINDOW_MS;
