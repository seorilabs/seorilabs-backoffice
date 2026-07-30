"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth-helpers";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import {
  APP_OPS_WORKFLOW_FILE,
  prepareAppOperation,
} from "@/lib/app-ops/operation";
import {
  getRepoDefaultBranch,
  getWorkflowDispatchInputNames,
} from "@/lib/github/read";
import { dispatchWorkflow } from "@/lib/github/write";
import { prisma } from "@/lib/prisma";

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

export async function dispatchAppOperationAction(
  input: DispatchAppOperationInput,
): Promise<DispatchAppOperationResult> {
  const session = await requireSession();
  try {
    const app = await prisma.app.findFirst({
      where: { id: input.appId, ...visibleAppWhere },
      select: {
        id: true,
        repoFullName: true,
        opsManifest: true,
      },
    });
    if (!app) throw new Error("앱을 찾을 수 없습니다.");

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
    const requiredInputs = ["operation", "request_id", "params_json", "reason"];
    const missingInput = requiredInputs.find((name) => !declaredInputs.has(name));
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
      inputs: {
        operation: prepared.operationKey,
        request_id: requestId,
        params_json: prepared.paramsJson,
        reason: prepared.reason ?? "",
      },
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
            params: prepared.params,
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
