import { AppOperationRunStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  PLATFORM_MIN_EXECUTION_WINDOW_MS,
  PLATFORM_OUTCOME_UNKNOWN_CODE,
  PLATFORM_REPO_FULL_NAME,
  PlatformOperationInputError,
  isPlatformWriteOperation,
  prepareQueuedSandboxResetClose,
  prepareQueuedSandboxResetResume,
  queuedPlatformOperationAppSlug,
  type PreparedPlatformOperation,
} from "@/lib/platform/operations";
import { isAppOpsRequestId } from "@/lib/app-ops/operation";
import {
  platformUnknownReconciliationConfirmationText,
  platformSandboxResetCloseConfirmationText,
  platformSandboxResetResumeConfirmationText,
  type PlatformUnknownReconciliationResolution,
} from "@/lib/platform/confirmation";
import type { PlatformBlockingReference } from "@/lib/platform/recovery";

const RESULT_TTL_MS = 24 * 60 * 60 * 1_000;
const PLATFORM_OUTCOME_RECONCILED_PREFIX = "platform_outcome_reconciled_";

interface EnqueuePlatformOperationInput {
  appId: string;
  actorLogin: string;
  prepared: PreparedPlatformOperation;
}

interface PlatformBlockingRow {
  requestId: string;
  operation: string;
  status: AppOperationRunStatus;
  error: string | null;
  expiresAt: Date;
}

export class PlatformBlockingOperationError extends PlatformOperationInputError {
  readonly reference: PlatformBlockingReference;

  constructor(message: string, reference: PlatformBlockingReference) {
    super(message);
    this.name = "PlatformBlockingOperationError";
    this.reference = reference;
  }
}

function platformBlockingReference(
  appSlug: string,
  row: PlatformBlockingRow,
  now = new Date(),
): PlatformBlockingReference {
  if (
    !isAppOpsRequestId(row.requestId) ||
    !isPlatformWriteOperation(row.operation)
  ) {
    throw new PlatformOperationInputError(
      "차단 중인 플랫폼 요청 참조 형식이 올바르지 않습니다.",
    );
  }
  const state =
    row.status === AppOperationRunStatus.PENDING ||
    row.status === AppOperationRunStatus.PROCESSING
      ? "in_progress"
      : row.error === PLATFORM_OUTCOME_UNKNOWN_CODE && row.expiresAt <= now
        ? "expired_unknown"
        : "unknown";
  return {
    requestId: row.requestId,
    appSlug,
    operation: row.operation,
    state,
  };
}

/** 서버 DB의 blocking row를 PII 없는 복구 참조로만 투영한다. */
export async function listBlockingPlatformOperations(
  apps: readonly { id: string; slug: string }[],
): Promise<PlatformBlockingReference[]> {
  if (apps.length === 0) return [];
  const appSlugById = new Map(apps.map((app) => [app.id, app.slug]));
  const rows = await prisma.appOperationRun.findMany({
    where: {
      appId: { in: apps.map((app) => app.id) },
      repoFullName: PLATFORM_REPO_FULL_NAME,
      OR: [
        {
          status: {
            in: [
              AppOperationRunStatus.PENDING,
              AppOperationRunStatus.PROCESSING,
            ],
          },
        },
        { error: PLATFORM_OUTCOME_UNKNOWN_CODE },
      ],
    },
    select: {
      appId: true,
      requestId: true,
      operation: true,
      status: true,
      error: true,
      expiresAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const references = new Map<string, PlatformBlockingReference>();
  const now = new Date();
  for (const row of rows) {
    if (references.has(row.appId)) continue;
    const appSlug = appSlugById.get(row.appId);
    if (!appSlug) continue;
    references.set(row.appId, platformBlockingReference(appSlug, row, now));
  }
  return [...references.values()].sort((left, right) => {
    const priority = { expired_unknown: 0, unknown: 1, in_progress: 2 };
    return priority[left.state] - priority[right.state];
  });
}

function platformAuditPayload(
  prepared: PreparedPlatformOperation,
): Prisma.InputJsonObject {
  return {
    requestId: prepared.requestId,
    repoFullName: PLATFORM_REPO_FULL_NAME,
    operation: prepared.operationKey,
    intent: "mutate",
    // 값은 AppOperationRun에만 짧게 보관한다. AuditLog에는 키만 남긴다.
    paramKeys: Object.keys(prepared.params).sort(),
    executor: "kubernetes",
  };
}

async function lockPlatformApp(
  tx: Prisma.TransactionClient,
  appId: string,
): Promise<void> {
  const lockedApp = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM app WHERE id = ${appId} FOR UPDATE
  `;
  if (lockedApp.length !== 1) {
    throw new PlatformOperationInputError(
      "플랫폼 요청 앱을 잠그지 못해 실행하지 않았습니다.",
    );
  }
}

/**
 * 새 모델을 만들지 않고 기존 AppOperationRun 큐를 쓴다.
 * 저장소·intent·executor는 호출자가 바꿀 수 없게 중앙에서 고정한다.
 */
export async function enqueuePlatformOperation(
  input: EnqueuePlatformOperationInput,
): Promise<void> {
  const expiresAt = new Date(Date.now() + RESULT_TTL_MS);
  await prisma.$transaction(async (tx) => {
    // 같은 app row를 먼저 잠근다. localStorage의 list→set은 탭 간 원자 연산이
    // 아니므로 서버가 직렬화하지 않으면 두 탭이 서로 다른 requestId로 동시에
    // grant source를 만들 수 있다. MySQL의 기존 app PK row를 쓰므로 새 lock
    // 테이블이나 만료 정리 작업은 필요 없다.
    await lockPlatformApp(tx, input.appId);

    // 처리 중이거나 결과 불명인 중앙 요청이 하나라도 있으면 새 ID를 열지 않는다.
    // app row lock 안에서 검사·생성을 이어가므로 동시 탭도 이 검사를 순서대로 탄다.
    const blocking = await tx.appOperationRun.findFirst({
      where: {
        appId: input.appId,
        repoFullName: PLATFORM_REPO_FULL_NAME,
        OR: [
          {
            status: {
              in: [
                AppOperationRunStatus.PENDING,
                AppOperationRunStatus.PROCESSING,
              ],
            },
          },
          { error: PLATFORM_OUTCOME_UNKNOWN_CODE },
        ],
      },
      select: {
        requestId: true,
        operation: true,
        status: true,
        error: true,
        expiresAt: true,
      },
    });
    if (blocking) {
      const reference = platformBlockingReference(
        input.prepared.appSlug,
        blocking,
      );
      throw new PlatformBlockingOperationError(
        blocking.error === PLATFORM_OUTCOME_UNKNOWN_CODE
          ? `수동 원장 대조가 필요한 결과 미확인 요청이 있습니다: ${blocking.requestId}`
          : `현재 처리 중인 플랫폼 요청이 있습니다: ${blocking.requestId}`,
        reference,
      );
    }

    await tx.appOperationRun.create({
      data: {
        requestId: input.prepared.requestId,
        appId: input.appId,
        repoFullName: PLATFORM_REPO_FULL_NAME,
        operation: input.prepared.operationKey,
        intent: "mutate",
        params: input.prepared.params as Prisma.InputJsonValue,
        reason: input.prepared.reason,
        actorLogin: input.actorLogin,
        expiresAt,
      },
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actorLogin,
        action: "platform.operation.enqueue",
        entityType: "app",
        entityId: input.appId,
        payload: platformAuditPayload(input.prepared),
      },
    });
  });
}

function retryUnknownUpdate(run: { expiresAt: Date }) {
  return {
    status: AppOperationRunStatus.PENDING,
    attempts: 0,
    // 원 요청의 actor는 플랫폼 멱등 fingerprint 일부다. 재시도 운영자로
    // 덮으면 이미 적용된 동일 ID가 replay mismatch가 된다.
    summary: "동일 request ID 수동 재실행 대기",
    result: Prisma.DbNull,
    // 이전 remote outcome 표식을 worker claim까지 유지한다. retry 전
    // 권한 실패가 실제 적용 가능성을 일반 실패로 평탄화하면 안 된다.
    error: PLATFORM_OUTCOME_UNKNOWN_CODE,
    startedAt: null,
    completedAt: null,
    // command envelope 보존 상한은 최초 enqueue부터 24시간이다. 수동 retry가
    // 같은 ID를 보존하더라도 TTL 자체를 새로 시작하지 않는다.
    expiresAt: run.expiresAt,
  };
}

function platformRetryExpiryThreshold(now: Date): Date {
  return new Date(now.getTime() + PLATFORM_MIN_EXECUTION_WINDOW_MS);
}

function retryUnknownWhere(
  runID: string,
  expiresAfter: Date,
  allowNullReason = false,
) {
  return {
    id: runID,
    status: AppOperationRunStatus.FAILED,
    error: PLATFORM_OUTCOME_UNKNOWN_CODE,
    redactedAt: null,
    params: { not: Prisma.DbNull },
    ...(allowNullReason ? {} : { reason: { not: null } }),
    expiresAt: { gt: expiresAfter },
  };
}

/**
 * 결과가 불명확하게 끝난 row만 같은 requestId로 재큐잉한다.
 * 브라우저가 PUID/entitlement를 다시 보내지 않고 DB의 원 요청을 재검증한다.
 */
export async function retryUnknownPlatformOperation(input: {
  appId: string;
  appSlug: string;
  actorLogin: string;
  requestId: string;
}): Promise<void> {
  if (!isAppOpsRequestId(input.requestId)) {
    throw new Error("요청 ID가 올바르지 않습니다.");
  }
  await prisma.$transaction(async (tx) => {
    // enqueue/reconcile과 같은 app lock 순서를 사용해 결과 불명 row의
    // 재큐잉과 수동 종료가 동시에 성공하지 않게 한다.
    await lockPlatformApp(tx, input.appId);
    const run = await tx.appOperationRun.findFirst({
      where: {
        appId: input.appId,
        requestId: input.requestId,
        repoFullName: PLATFORM_REPO_FULL_NAME,
      },
    });
    // app lock 대기 중 시간이 흘렀을 수 있으므로 row를 읽은 뒤 다시 잡는다.
    // worker가 실제 remote 호출을 시작할 수 없는 만료 직전 retry는 열지 않는다.
    const retryExpiresAfter = platformRetryExpiryThreshold(new Date());
    if (
      !run ||
      run.status !== AppOperationRunStatus.FAILED ||
      run.error !== PLATFORM_OUTCOME_UNKNOWN_CODE ||
      run.redactedAt !== null ||
      run.expiresAt <= retryExpiresAfter ||
      !run.params
    ) {
      throw new Error(
        "동일 request ID로 재실행할 수 있는 결과 미확인 요청이 아닙니다.",
      );
    }

    // DB row도 외부 입력으로 보고 다시 검증한다. payload를 바꾼 retry는 없다.
    const queuedInput = {
      requestId: run.requestId,
      operation: run.operation,
      params: run.params,
      reason: run.reason,
    };
    const preparedRecovery =
      prepareQueuedSandboxResetResume(queuedInput) ??
      prepareQueuedSandboxResetClose(queuedInput);
    if (!preparedRecovery && !run.reason) {
      throw new Error(
        "동일 request ID로 재실행할 수 있는 결과 미확인 요청이 아닙니다.",
      );
    }
    const queuedAppSlug = queuedPlatformOperationAppSlug(queuedInput);
    if (queuedAppSlug !== input.appSlug) {
      throw new Error("결과 미확인 요청의 앱 결합이 일치하지 않습니다.");
    }

    const updated = await tx.appOperationRun.updateMany({
      // TTL cleanup은 app lock을 잡지 않는다. payload와 redaction까지 같은
      // updateMany CAS에서 재확인해 조회 뒤 정리된 row를 되열지 않는다.
      where: retryUnknownWhere(
        run.id,
        retryExpiresAfter,
        preparedRecovery !== null,
      ),
      data: retryUnknownUpdate(run),
    });
    if (updated.count !== 1) {
      throw new Error("결과 미확인 요청 상태가 변경되어 재실행하지 않았습니다.");
    }
    await tx.auditLog.create({
      data: {
        actorLogin: input.actorLogin,
        action: "platform.operation.retry_unknown",
        entityType: "app",
        entityId: input.appId,
        payload: {
          requestId: input.requestId,
          repoFullName: PLATFORM_REPO_FULL_NAME,
          operation: run.operation,
          executor: "kubernetes",
        },
      },
    });
  });
}

function reconciledUnknownCode(
  resolution: PlatformUnknownReconciliationResolution,
): string {
  return `${PLATFORM_OUTCOME_RECONCILED_PREFIX}${resolution}`;
}

function reconciledUnknownUpdate(
  resolution: PlatformUnknownReconciliationResolution,
  redactedAt: Date,
) {
  return {
    status: AppOperationRunStatus.FAILED,
    summary:
      resolution === "applied"
        ? "수동 원장 대조 완료 · 플랫폼 적용 확인"
        : "수동 원장 대조 완료 · 플랫폼 미적용 확인",
    error: reconciledUnknownCode(resolution),
    params: Prisma.DbNull,
    result: Prisma.DbNull,
    reason: null,
    // 이미 TTL cleanup이 기록한 최초 redaction 시각을 덮지 않는다.
    redactedAt,
  };
}

function reconciliationAuditPayload(input: {
  requestId: string;
  operation: string;
  resolution: PlatformUnknownReconciliationResolution;
}): Prisma.InputJsonObject {
  return {
    requestId: input.requestId,
    repoFullName: PLATFORM_REPO_FULL_NAME,
    operation: input.operation,
    resolution: input.resolution,
    closure: "manual_ledger_reconciliation",
    confirmationPolicy: "typed_exact",
  };
}

export type PlatformSandboxResetRemoteState =
  | "absent"
  | "prepared"
  | "completed"
  | "closed_not_started";

function assertSandboxResetReconciliation(
  state: PlatformSandboxResetRemoteState | undefined,
  resolution: PlatformUnknownReconciliationResolution,
): void {
  if (state === undefined) {
    throw new PlatformOperationInputError(
      "sandbox reset durable intent 상태를 확인하지 못해 대조 종료하지 않았습니다.",
    );
  }
  if (state === "prepared") {
    throw new PlatformOperationInputError(
      "sandbox reset이 prepared 상태입니다. 잠금을 닫거나 새 request ID를 만들지 말고 동일 request ID로 재개하세요.",
    );
  }
  if (state === "absent") {
    throw new PlatformOperationInputError(
      "sandbox reset intent 부재는 먼저 영구 미시작 종료를 확정해야 합니다.",
    );
  }
  if (state === "completed" && resolution !== "applied") {
    throw new PlatformOperationInputError(
      "완료된 sandbox reset은 플랫폼 적용 확인으로만 대조 종료할 수 있습니다.",
    );
  }
  if (state === "closed_not_started" && resolution !== "not_applied") {
    throw new PlatformOperationInputError(
      "영구 미시작 종료된 sandbox reset은 플랫폼 미적용 확인으로만 대조 종료할 수 있습니다.",
    );
  }
}

function sandboxResetResumeUpdate(input: {
  appSlug: string;
  requestId: string;
  actorLogin: string;
  confirmation: string;
  now: Date;
}) {
  const expected = platformSandboxResetResumeConfirmationText(input);
  if (input.confirmation !== expected) {
    throw new PlatformOperationInputError(
      "sandbox reset 재개 확인 문구가 정확히 일치하지 않습니다.",
    );
  }
  return {
    status: AppOperationRunStatus.PENDING,
    attempts: 0,
    params: {
      appSlug: input.appSlug,
      resumePreparedReset: true,
      serverConfirmation: input.confirmation,
    } as Prisma.InputJsonObject,
    reason: null,
    actorLogin: input.actorLogin,
    summary: "prepared sandbox reset 동일 request ID 재개 대기",
    result: Prisma.DbNull,
    // remote completion 전까지 기존 unknown 표식을 유지한다. worker의 권한
    // 재검증이나 재중단이 새 ID를 열 수 있는 일반 실패로 바꾸면 안 된다.
    error: PLATFORM_OUTCOME_UNKNOWN_CODE,
    startedAt: null,
    completedAt: null,
    // 민감 payload가 아닌 resume envelope에 새 처리 시간을 부여한다.
    expiresAt: new Date(input.now.getTime() + RESULT_TTL_MS),
    redactedAt: null,
  };
}

function sandboxResetCloseUpdate(input: {
  appSlug: string;
  requestId: string;
  actorLogin: string;
  confirmation: string;
  now: Date;
}) {
  const expected = platformSandboxResetCloseConfirmationText(input);
  if (input.confirmation !== expected) {
    throw new PlatformOperationInputError(
      "sandbox reset 미시작 종료 확인 문구가 정확히 일치하지 않습니다.",
    );
  }
  return {
    status: AppOperationRunStatus.PENDING,
    attempts: 0,
    params: {
      appSlug: input.appSlug,
      closeNotStartedReset: true,
      serverConfirmation: input.confirmation,
    } as Prisma.InputJsonObject,
    reason: null,
    actorLogin: input.actorLogin,
    summary: "sandbox reset 영구 미시작 종료 대기",
    result: Prisma.DbNull,
    // closure 응답이 유실되어도 기존 unknown 표식을 유지해 새 ID를 막는다.
    error: PLATFORM_OUTCOME_UNKNOWN_CODE,
    startedAt: null,
    completedAt: null,
    expiresAt: new Date(input.now.getTime() + RESULT_TTL_MS),
    redactedAt: null,
  };
}

/**
 * remote absent를 곧바로 local not_applied로 닫지 않고 같은 row를 write worker에
 * 넘긴다. platform의 permanent closure가 성공한 뒤 worker completion이 잠금을 푼다.
 */
export async function closeNotStartedSandboxResetOperation(input: {
  appId: string;
  appSlug: string;
  actorLogin: string;
  requestId: string;
  confirmation: string;
}): Promise<void> {
  if (!isAppOpsRequestId(input.requestId)) {
    throw new PlatformOperationInputError("요청 ID가 올바르지 않습니다.");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.appSlug)) {
    throw new PlatformOperationInputError("앱 식별자가 올바르지 않습니다.");
  }
  const now = new Date();
  const update = sandboxResetCloseUpdate({ ...input, now });

  await prisma.$transaction(async (tx) => {
    await lockPlatformApp(tx, input.appId);
    const run = await tx.appOperationRun.findFirst({
      where: {
        appId: input.appId,
        requestId: input.requestId,
        repoFullName: PLATFORM_REPO_FULL_NAME,
        operation: "platform.iap.reset-app-store-sandbox",
        status: AppOperationRunStatus.FAILED,
        error: PLATFORM_OUTCOME_UNKNOWN_CODE,
        expiresAt: { lte: now },
      },
      select: { id: true },
    });
    if (!run) {
      throw new PlatformOperationInputError(
        "미시작 종료할 수 있는 만료된 sandbox reset 요청이 아닙니다.",
      );
    }
    const updated = await tx.appOperationRun.updateMany({
      where: {
        id: run.id,
        operation: "platform.iap.reset-app-store-sandbox",
        status: AppOperationRunStatus.FAILED,
        error: PLATFORM_OUTCOME_UNKNOWN_CODE,
        expiresAt: { lte: now },
      },
      data: update,
    });
    if (updated.count !== 1) {
      throw new PlatformOperationInputError(
        "sandbox reset 요청 상태가 변경되어 미시작 종료하지 않았습니다.",
      );
    }
    await tx.auditLog.create({
      data: {
        actorLogin: input.actorLogin,
        action: "platform.operation.close_not_started_sandbox_reset",
        entityType: "app",
        entityId: input.appId,
        payload: {
          requestId: input.requestId,
          repoFullName: PLATFORM_REPO_FULL_NAME,
          operation: "platform.iap.reset-app-store-sandbox",
          remoteState: "absent",
          executor: "kubernetes",
          confirmationPolicy: "typed_exact",
        },
      },
    });
  });
}

/**
 * prepared durable intent만 같은 AppOperationRun/requestId로 worker에 다시 넘긴다.
 * 새 command row를 만들지 않아 reset과 백오피스 잠금의 멱등 경계를 유지한다.
 */
export async function resumePreparedSandboxResetOperation(input: {
  appId: string;
  appSlug: string;
  actorLogin: string;
  requestId: string;
  confirmation: string;
}): Promise<void> {
  if (!isAppOpsRequestId(input.requestId)) {
    throw new PlatformOperationInputError("요청 ID가 올바르지 않습니다.");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.appSlug)) {
    throw new PlatformOperationInputError("앱 식별자가 올바르지 않습니다.");
  }
  const now = new Date();
  const update = sandboxResetResumeUpdate({ ...input, now });

  await prisma.$transaction(async (tx) => {
    await lockPlatformApp(tx, input.appId);
    const run = await tx.appOperationRun.findFirst({
      where: {
        appId: input.appId,
        requestId: input.requestId,
        repoFullName: PLATFORM_REPO_FULL_NAME,
        operation: "platform.iap.reset-app-store-sandbox",
        status: AppOperationRunStatus.FAILED,
        error: PLATFORM_OUTCOME_UNKNOWN_CODE,
        expiresAt: { lte: now },
      },
      select: { id: true },
    });
    if (!run) {
      throw new PlatformOperationInputError(
        "재개할 수 있는 만료된 sandbox reset 요청이 아닙니다.",
      );
    }
    const updated = await tx.appOperationRun.updateMany({
      where: {
        id: run.id,
        operation: "platform.iap.reset-app-store-sandbox",
        status: AppOperationRunStatus.FAILED,
        error: PLATFORM_OUTCOME_UNKNOWN_CODE,
        expiresAt: { lte: now },
      },
      data: update,
    });
    if (updated.count !== 1) {
      throw new PlatformOperationInputError(
        "sandbox reset 요청 상태가 변경되어 재개하지 않았습니다.",
      );
    }
    await tx.auditLog.create({
      data: {
        actorLogin: input.actorLogin,
        action: "platform.operation.resume_prepared_sandbox_reset",
        entityType: "app",
        entityId: input.appId,
        payload: {
          requestId: input.requestId,
          repoFullName: PLATFORM_REPO_FULL_NAME,
          operation: "platform.iap.reset-app-store-sandbox",
          remoteState: "prepared",
          executor: "kubernetes",
          confirmationPolicy: "typed_exact",
        },
      },
    });
  });
}

/**
 * 24시간이 지나 payload가 제거된 unknown row는 재실행할 수 없다. 운영자가
 * 플랫폼 원장과 감사 기록을 대조한 판정만 별도 감사 로그로 남기고 앱 lock을
 * 해제한다. 원 IAP 원장이나 command row는 삭제하지 않는다.
 */
export async function reconcileExpiredUnknownPlatformOperation(input: {
  appId: string;
  appSlug: string;
  actorLogin: string;
  requestId: string;
  resolution: PlatformUnknownReconciliationResolution;
  confirmation: string;
  sandboxResetState?: PlatformSandboxResetRemoteState;
}): Promise<void> {
  if (!isAppOpsRequestId(input.requestId)) {
    throw new PlatformOperationInputError("요청 ID가 올바르지 않습니다.");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.appSlug)) {
    throw new PlatformOperationInputError("앱 식별자가 올바르지 않습니다.");
  }
  if (input.resolution !== "applied" && input.resolution !== "not_applied") {
    throw new PlatformOperationInputError("수동 대조 결과를 선택해야 합니다.");
  }
  const expectedConfirmation =
    platformUnknownReconciliationConfirmationText(input);
  if (input.confirmation !== expectedConfirmation) {
    throw new PlatformOperationInputError(
      "결과 불명 대조 확인 문구가 정확히 일치하지 않습니다.",
    );
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await lockPlatformApp(tx, input.appId);
    const run = await tx.appOperationRun.findFirst({
      where: {
        appId: input.appId,
        requestId: input.requestId,
        repoFullName: PLATFORM_REPO_FULL_NAME,
        status: AppOperationRunStatus.FAILED,
        error: PLATFORM_OUTCOME_UNKNOWN_CODE,
        expiresAt: { lte: now },
      },
      select: { id: true, operation: true, redactedAt: true },
    });
    if (!run) {
      throw new PlatformOperationInputError(
        "대조 종료할 수 있는 만료된 결과 미확인 요청이 아닙니다.",
      );
    }

    if (run.operation === "platform.iap.reset-app-store-sandbox") {
      assertSandboxResetReconciliation(
        input.sandboxResetState,
        input.resolution,
      );
    }

    const updated = await tx.appOperationRun.updateMany({
      where: {
        id: run.id,
        status: AppOperationRunStatus.FAILED,
        error: PLATFORM_OUTCOME_UNKNOWN_CODE,
        expiresAt: { lte: now },
      },
      data: reconciledUnknownUpdate(input.resolution, run.redactedAt ?? now),
    });
    if (updated.count !== 1) {
      throw new PlatformOperationInputError(
        "결과 미확인 요청 상태가 변경되어 대조 종료하지 않았습니다.",
      );
    }
    await tx.auditLog.create({
      data: {
        actorLogin: input.actorLogin,
        action: "platform.operation.reconcile_expired_unknown",
        entityType: "app",
        entityId: input.appId,
        payload: reconciliationAuditPayload({
          requestId: input.requestId,
          operation: run.operation,
          resolution: input.resolution,
        }),
      },
    });
  });
}

export const platformAuditPayloadForTest = platformAuditPayload;
export const retryUnknownUpdateForTest = retryUnknownUpdate;
export const platformRetryExpiryThresholdForTest =
  platformRetryExpiryThreshold;
export const retryUnknownWhereForTest = retryUnknownWhere;
export const reconciledUnknownUpdateForTest = reconciledUnknownUpdate;
export const reconciliationAuditPayloadForTest = reconciliationAuditPayload;
export const platformBlockingReferenceForTest = platformBlockingReference;
export const assertSandboxResetReconciliationForTest =
  assertSandboxResetReconciliation;
export const sandboxResetResumeUpdateForTest = sandboxResetResumeUpdate;
export const sandboxResetCloseUpdateForTest = sandboxResetCloseUpdate;
