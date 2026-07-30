import {
  AppOperationRunStatus,
  Prisma,
  type AppOperationRun,
} from "@prisma/client";

import {
  appOpsResultSchema,
  isAppOpsRequestId,
  type AppOpsResult,
  type PreparedAppOperation,
} from "@/lib/app-ops/operation";
import { prisma } from "@/lib/prisma";

const RESULT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface AppOpsRunSummary {
  requestId: string;
  operation: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppOpsRunStatus extends AppOpsRunSummary {
  result?: AppOpsResult;
  resultError?: string;
}

function summaryStatus(status: AppOperationRunStatus): Pick<
  AppOpsRunSummary,
  "status" | "conclusion"
> {
  if (status === AppOperationRunStatus.PENDING) {
    return { status: "queued", conclusion: null };
  }
  if (status === AppOperationRunStatus.PROCESSING) {
    return { status: "in_progress", conclusion: null };
  }
  return {
    status: "completed",
    conclusion:
      status === AppOperationRunStatus.SUCCEEDED ? "success" : "failure",
  };
}

function toSummary(run: AppOperationRun): AppOpsRunSummary {
  return {
    requestId: run.requestId,
    operation: run.operation,
    ...summaryStatus(run.status),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export async function enqueueAppOperation(input: {
  appId: string;
  repoFullName: string;
  actorLogin: string | null;
  prepared: PreparedAppOperation;
  requestId: string;
}): Promise<void> {
  if (!isAppOpsRequestId(input.requestId)) {
    throw new Error("백오피스 request_id가 올바르지 않습니다.");
  }
  const expiresAt = new Date(Date.now() + RESULT_TTL_MS);
  await prisma.$transaction([
    prisma.appOperationRun.create({
      data: {
        requestId: input.requestId,
        appId: input.appId,
        repoFullName: input.repoFullName,
        operation: input.prepared.operationKey,
        intent: input.prepared.operation.intent,
        params: input.prepared.params as Prisma.InputJsonValue,
        reason:
          input.prepared.reason ??
          `백오피스 조회 실행 · ${input.prepared.operationKey}`,
        actorLogin: input.actorLogin,
        expiresAt,
      },
    }),
    prisma.auditLog.create({
      data: {
        actorLogin: input.actorLogin,
        action: "app.operation.enqueue",
        entityType: "app",
        entityId: input.appId,
        payload: {
          requestId: input.requestId,
          repoFullName: input.repoFullName,
          operation: input.prepared.operationKey,
          intent: input.prepared.operation.intent,
          paramKeys: Object.keys(input.prepared.params),
          reason: input.prepared.reason,
          executor: "kubernetes",
        },
      },
    }),
  ]);
}

export async function getAppOperationRunStatus(
  appId: string,
  requestId: string,
): Promise<AppOpsRunStatus | null> {
  if (!isAppOpsRequestId(requestId)) {
    throw new Error("요청 ID가 올바르지 않습니다.");
  }
  const run = await prisma.appOperationRun.findFirst({
    where: { appId, requestId },
  });
  if (!run) return null;

  const summary = toSummary(run);
  if (summary.status !== "completed") return summary;
  if (!run.result) {
    return {
      ...summary,
      resultError:
        run.error ??
        (run.expiresAt <= new Date()
          ? "민감한 실행 결과의 보관 기간이 만료됐습니다."
          : "worker 결과가 없습니다."),
    };
  }
  const parsed = appOpsResultSchema.safeParse(run.result);
  if (!parsed.success) {
    return { ...summary, resultError: "worker 결과 형식이 올바르지 않습니다." };
  }
  return { ...summary, result: parsed.data };
}

export async function listRecentAppOperationRuns(
  appId: string,
  limit = 10,
): Promise<AppOpsRunSummary[]> {
  const rows = await prisma.appOperationRun.findMany({
    where: { appId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 50),
  });
  return rows.map(toSummary);
}

export const appOpsRunStatusForTest = summaryStatus;
