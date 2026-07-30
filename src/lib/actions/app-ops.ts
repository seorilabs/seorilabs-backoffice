"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import {
  APP_OPS_WORKFLOW_FILE,
  APP_OPS_WORKFLOW_INPUTS,
  buildAppOpsWorkflowInputs,
  prepareAppOperation,
  type AppOpsResult,
} from "@/lib/app-ops/operation";
import { requireSession } from "@/lib/auth-helpers";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import {
  getAppOpsRunStatus,
  listRecentAppOpsRuns,
  type AppOpsRunSummary,
} from "@/lib/github/app-ops";
import {
  getRepoDefaultBranch,
  getWorkflowDispatchInputNames,
} from "@/lib/github/read";
import { dispatchWorkflow } from "@/lib/github/write";
import { prisma } from "@/lib/prisma";

interface OperationApp {
  id: string;
  repoFullName: string;
  opsManifest: unknown;
}

export interface DispatchAppOperationInput {
  appId: string;
  toolId: string;
  operationId: string;
  values?: Record<string, string | number | boolean>;
  reason?: string;
  confirmationText?: string;
}

export interface DispatchAppOperationResult {
  ok: boolean;
  requestId?: string;
  workflowUrl?: string;
  error?: string;
}

export interface AppOperationStatusResponse {
  ok: boolean;
  found?: boolean;
  status?: string;
  conclusion?: string | null;
  url?: string;
  result?: AppOpsResult;
  resultError?: string;
  error?: string;
}

async function operationApp(appId: string): Promise<OperationApp> {
  const app = await prisma.app.findFirst({
    where: { id: appId, ...visibleAppWhere },
    select: {
      id: true,
      repoFullName: true,
      opsManifest: true,
    },
  });
  if (!app) throw new Error("앱을 찾을 수 없습니다.");
  return app;
}

export async function dispatchAppOperationAction(
  input: DispatchAppOperationInput,
): Promise<DispatchAppOperationResult> {
  const session = await requireSession();
  try {
    const app = await operationApp(input.appId);
    const prepared = prepareAppOperation({
      manifestValue: app.opsManifest,
      toolId: input.toolId,
      operationId: input.operationId,
      values: input.values,
      reason: input.reason,
      confirmationText: input.confirmationText,
    });
    const defaultBranch = await getRepoDefaultBranch(app.repoFullName);
    const declaredInputs = await getWorkflowDispatchInputNames(
      app.repoFullName,
      APP_OPS_WORKFLOW_FILE,
      defaultBranch,
    );
    const missingInput = APP_OPS_WORKFLOW_INPUTS.find(
      (name) => !declaredInputs.has(name),
    );
    if (missingInput) {
      throw new Error(
        `${APP_OPS_WORKFLOW_FILE}에 표준 입력이 없습니다: ${missingInput}`,
      );
    }

    const requestId = randomUUID();
    await dispatchWorkflow({
      repoFullName: app.repoFullName,
      workflowFile: APP_OPS_WORKFLOW_FILE,
      ref: defaultBranch,
      inputs: buildAppOpsWorkflowInputs(prepared, requestId),
    });

    await prisma.auditLog
      .create({
        data: {
          actorLogin: session.user.login ?? null,
          action: "app.operation.dispatch",
          entityType: "app",
          entityId: app.id,
          payload: {
            requestId,
            repoFullName: app.repoFullName,
            operation: prepared.operationKey,
            intent: prepared.operation.intent,
            paramKeys: Object.keys(prepared.params),
            reason: prepared.reason,
          },
        },
      })
      .catch(() => {});

    revalidatePath(`/apps/${app.id}`);
    return {
      ok: true,
      requestId,
      workflowUrl: `https://github.com/${app.repoFullName}/actions/workflows/${APP_OPS_WORKFLOW_FILE}`,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function getAppOperationStatusAction(
  appId: string,
  requestId: string,
): Promise<AppOperationStatusResponse> {
  await requireSession();
  try {
    const app = await operationApp(appId);
    const run = await getAppOpsRunStatus(app.repoFullName, requestId);
    if (!run) return { ok: true, found: false, status: "waiting" };
    return {
      ok: true,
      found: true,
      status: run.status,
      conclusion: run.conclusion,
      url: run.url,
      result: run.result,
      resultError: run.resultError,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function listAppOperationRunsAction(
  appId: string,
): Promise<{ ok: boolean; runs?: AppOpsRunSummary[]; error?: string }> {
  await requireSession();
  try {
    const app = await operationApp(appId);
    return { ok: true, runs: await listRecentAppOpsRuns(app.repoFullName) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
