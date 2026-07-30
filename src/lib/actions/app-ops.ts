"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import {
  prepareAppOperation,
  type AppOpsResult,
} from "@/lib/app-ops/operation";
import {
  enqueueAppOperation,
  getAppOperationRunStatus,
  listRecentAppOperationRuns,
  type AppOpsRunSummary,
} from "@/lib/app-ops/runs";
import { requireSession } from "@/lib/auth-helpers";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
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
  error?: string;
}

export interface AppOperationStatusResponse {
  ok: boolean;
  found?: boolean;
  status?: string;
  conclusion?: string | null;
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

    const requestId = randomUUID();
    await enqueueAppOperation({
      appId: app.id,
      repoFullName: app.repoFullName,
      actorLogin: session.user.login ?? null,
      prepared,
      requestId,
    });

    revalidatePath(`/apps/${app.id}`);
    return { ok: true, requestId };
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
    const run = await getAppOperationRunStatus(app.id, requestId);
    if (!run) return { ok: true, found: false, status: "waiting" };
    return {
      ok: true,
      found: true,
      status: run.status,
      conclusion: run.conclusion,
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
    return { ok: true, runs: await listRecentAppOperationRuns(app.id) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
