"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import {
  APP_OPS_WORKFLOW_INPUTS,
  encodeTargetRef,
  findManifestOperation,
  operationKey,
  validateOperationConfirmation,
  validateOperationInputs,
  type AppOpsResult,
} from "@/lib/app-ops/execution";
import { parseAppOpsManifest } from "@/lib/app-ops/manifest";
import { requireSession } from "@/lib/auth-helpers";
import { HIDDEN_APP_ERROR, isDisabledAppStatus } from "@/lib/domain/app-visibility";
import { getWorkflowDispatchInputNames } from "@/lib/github/read";
import {
  dispatchAppOpsWorkflow,
  getAppOpsRunStatus,
  getRepoDefaultBranch,
  listRecentAppOpsRuns,
  type AppOpsRunSummary,
} from "@/lib/github/app-ops";
import { prisma } from "@/lib/prisma";

interface OperationApp {
  id: string;
  repoFullName: string;
  opsManifest: unknown;
}

export interface DispatchAppOperationResponse {
  ok: boolean;
  requestId?: string;
  actionsUrl?: string;
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
  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: {
      id: true,
      repoFullName: true,
      opsManifest: true,
      status: true,
    },
  });
  if (!app) throw new Error("앱을 찾을 수 없습니다.");
  if (isDisabledAppStatus(app.status)) throw new Error(HIDDEN_APP_ERROR);
  return app;
}

export async function dispatchAppOperationAction(
  appId: string,
  toolId: string,
  operationId: string,
  rawValues: Record<string, unknown>,
  rawReason: string,
  typedConfirmation: string,
): Promise<DispatchAppOperationResponse> {
  const session = await requireSession();
  try {
    const app = await operationApp(appId);
    const parsed = parseAppOpsManifest(app.opsManifest);
    if (!parsed.manifest) throw new Error(parsed.error ?? "유효한 운영 manifest가 없습니다.");
    const match = findManifestOperation(parsed.manifest, toolId, operationId);
    if (!match) throw new Error("manifest에 선언되지 않은 오퍼레이션입니다.");

    const values = validateOperationInputs(match.operation, rawValues);
    const reason = validateOperationConfirmation({
      toolId,
      operation: match.operation,
      reason: rawReason,
      typedConfirmation,
    });
    const defaultBranch = await getRepoDefaultBranch(app.repoFullName);
    const declaredInputs = await getWorkflowDispatchInputNames(
      app.repoFullName,
      "backoffice-ops.yml",
      defaultBranch,
    );
    const missingInput = APP_OPS_WORKFLOW_INPUTS.find((input) => !declaredInputs.has(input));
    if (missingInput) {
      throw new Error(`표준 backoffice-ops.yml 입력이 없습니다: ${missingInput}`);
    }

    const requestId = randomUUID();
    const actor = session.user.login ?? "unknown";
    const auditReason = reason
      ? `[web:${actor}] ${reason}`
      : `[web:${actor}] read-only operation`;
    await dispatchAppOpsWorkflow({
      repoFullName: app.repoFullName,
      ref: defaultBranch,
      operation: operationKey(toolId, operationId),
      requestId,
      targetRef: encodeTargetRef(values),
      reason: auditReason,
    });
    revalidatePath(`/apps/${app.id}`);
    return {
      ok: true,
      requestId,
      actionsUrl: `https://github.com/${app.repoFullName}/actions/workflows/backoffice-ops.yml`,
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
