import {
  AppOperationRunStatus,
  Prisma,
  type AppOperationRun,
} from "@prisma/client";

import { executeLizardTycoonOperation } from "@/lib/app-ops/adapters/lizard-tycoon";
import {
  appOpsResultSchema,
  type AppOperationValues,
  type AppOpsResult,
} from "@/lib/app-ops/operation";
import { prisma } from "@/lib/prisma";

const MAX_ATTEMPTS = 3;
const STALE_AFTER_MS = 10 * 60 * 1_000;

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "알 수 없는 오류";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[REDACTED]")
    .slice(0, 500);
}

export async function executeAppOperation(
  run: AppOperationRun,
): Promise<AppOpsResult> {
  const params =
    run.params && typeof run.params === "object" && !Array.isArray(run.params)
      ? (run.params as AppOperationValues)
      : {};

  if (run.repoFullName === "seorilabs/lizard-tycoon") {
    return executeLizardTycoonOperation({
      requestId: run.requestId,
      operation: run.operation,
      params,
    });
  }
  throw new Error(`등록되지 않은 Kubernetes AppOps adapter: ${run.repoFullName}`);
}

export async function recoverStaleAppOperations(now = new Date()): Promise<void> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
  const stale = await prisma.appOperationRun.findMany({
    where: {
      status: AppOperationRunStatus.PROCESSING,
      startedAt: { lt: staleBefore },
    },
    select: { id: true, attempts: true },
  });
  for (const run of stale) {
    if (run.attempts >= MAX_ATTEMPTS) {
      await prisma.appOperationRun.updateMany({
        where: {
          id: run.id,
          status: AppOperationRunStatus.PROCESSING,
        },
        data: {
          status: AppOperationRunStatus.FAILED,
          summary: "worker 재시도 한도를 초과했습니다.",
          error: "worker timeout",
          completedAt: now,
        },
      });
    } else {
      await prisma.appOperationRun.updateMany({
        where: {
          id: run.id,
          status: AppOperationRunStatus.PROCESSING,
        },
        data: {
          status: AppOperationRunStatus.PENDING,
          startedAt: null,
        },
      });
    }
  }
}

export async function redactExpiredAppOperations(
  now = new Date(),
): Promise<number> {
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
  if (expired.length === 0) return 0;
  const updated = await prisma.appOperationRun.updateMany({
    where: { id: { in: expired.map(({ id }) => id) } },
    data: {
      params: Prisma.DbNull,
      result: Prisma.DbNull,
      redactedAt: now,
    },
  });
  return updated.count;
}

async function claimNextAppOperation(): Promise<AppOperationRun | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await prisma.appOperationRun.findFirst({
      where: {
        status: AppOperationRunStatus.PENDING,
        attempts: { lt: MAX_ATTEMPTS },
      },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) return null;
    const startedAt = new Date();
    const claimed = await prisma.appOperationRun.updateMany({
      where: {
        id: candidate.id,
        status: AppOperationRunStatus.PENDING,
        attempts: candidate.attempts,
      },
      data: {
        status: AppOperationRunStatus.PROCESSING,
        attempts: { increment: 1 },
        startedAt,
        error: null,
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

  try {
    const result = appOpsResultSchema.parse(await executeAppOperation(run));
    await prisma.appOperationRun.update({
      where: { id: run.id },
      data: {
        status: AppOperationRunStatus.SUCCEEDED,
        summary: result.summary,
        result: result as Prisma.InputJsonValue,
        error: null,
        completedAt: new Date(),
        params: Prisma.DbNull,
      },
    });
  } catch (error) {
    const summary = safeErrorMessage(error);
    const result: AppOpsResult = {
      version: 1,
      requestId: run.requestId,
      operation: run.operation,
      status: "error",
      summary,
      completedAt: new Date().toISOString(),
    };
    await prisma.appOperationRun.update({
      where: { id: run.id },
      data: {
        status: AppOperationRunStatus.FAILED,
        summary,
        result: result as Prisma.InputJsonValue,
        error: summary,
        completedAt: new Date(),
        params: Prisma.DbNull,
      },
    });
  }
  return true;
}

export const safeAppOpsErrorForTest = safeErrorMessage;
