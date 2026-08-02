import { AppOperationRunStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  PLATFORM_OUTCOME_UNKNOWN_CODE,
  PLATFORM_REPO_FULL_NAME,
  PlatformOperationInputError,
  prepareQueuedPlatformOperation,
  type PreparedPlatformOperation,
} from "@/lib/platform/operations";
import { isAppOpsRequestId } from "@/lib/app-ops/operation";

const RESULT_TTL_MS = 24 * 60 * 60 * 1_000;

interface EnqueuePlatformOperationInput {
  appId: string;
  actorLogin: string;
  prepared: PreparedPlatformOperation;
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
    const lockedApp = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM app WHERE id = ${input.appId} FOR UPDATE
    `;
    if (lockedApp.length !== 1) {
      throw new PlatformOperationInputError(
        "플랫폼 요청 앱을 잠그지 못해 실행하지 않았습니다.",
      );
    }

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
      select: { requestId: true, error: true },
    });
    if (blocking?.error === PLATFORM_OUTCOME_UNKNOWN_CODE) {
      throw new PlatformOperationInputError(
        `수동 원장 대조가 필요한 결과 미확인 요청이 있습니다: ${blocking.requestId}`,
      );
    }
    if (blocking) {
      throw new PlatformOperationInputError(
        `현재 처리 중인 플랫폼 요청이 있습니다: ${blocking.requestId}`,
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
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const run = await tx.appOperationRun.findFirst({
      where: {
        appId: input.appId,
        requestId: input.requestId,
        repoFullName: PLATFORM_REPO_FULL_NAME,
      },
    });
    if (
      !run ||
      run.status !== AppOperationRunStatus.FAILED ||
      run.error !== PLATFORM_OUTCOME_UNKNOWN_CODE ||
      run.expiresAt <= now ||
      !run.params ||
      !run.reason
    ) {
      throw new Error(
        "동일 request ID로 재실행할 수 있는 결과 미확인 요청이 아닙니다.",
      );
    }

    // DB row도 외부 입력으로 보고 다시 검증한다. payload를 바꾼 retry는 없다.
    const prepared = prepareQueuedPlatformOperation({
      requestId: run.requestId,
      operation: run.operation,
      params: run.params,
      reason: run.reason,
    });
    if (prepared.appSlug !== input.appSlug) {
      throw new Error("결과 미확인 요청의 앱 결합이 일치하지 않습니다.");
    }

    const updated = await tx.appOperationRun.updateMany({
      where: {
        id: run.id,
        status: AppOperationRunStatus.FAILED,
        error: PLATFORM_OUTCOME_UNKNOWN_CODE,
        expiresAt: { gt: now },
      },
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

export const platformAuditPayloadForTest = platformAuditPayload;
export const retryUnknownUpdateForTest = retryUnknownUpdate;
