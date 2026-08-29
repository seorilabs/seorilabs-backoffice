"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import {
  automationDefinitionCommandSchema,
  automationDefinitionCreateSchema,
  configActivationSchema,
  configRevisionSchema,
  legacyShadowImportRequestSchema,
} from "@/lib/control-plane/contracts";
import {
  createAutomationDefinition,
  executeAutomationCommand,
} from "@/lib/control-plane/automation-service";
import { recordLegacyShadowImport } from "@/lib/control-plane/legacy-shadow-service";
import { advanceFleetLifecycleStageFromHumanUi } from "@/lib/control-plane/lifecycle-service";
import { fleetLifecycleHumanTransitionSchema } from "@/lib/control-plane/lifecycle-policy";
import { approveProviderExecution } from "@/lib/control-plane/provider-execution-service";
import {
  activateConfigRevision,
  createConfigRevision,
  markReauthTrustedLocalPendingFromHumanUi,
} from "@/lib/control-plane/service";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import {
  requirePlatformReadAccess,
  requirePlatformWriteAccess,
} from "@/lib/platform/access";
import { prisma } from "@/lib/prisma";

export interface FleetActionResult {
  ok: boolean;
  error?: string;
  revision?: number;
  status?: string;
  importId?: string;
  parityStatus?: string | null;
  definitionId?: string;
  stage?: string;
  generation?: number;
}

const uiRequestIdSchema = z.string().uuid();
const trustedLocalHumanUiSchema = z.object({
  appId: z.string().min(1).max(191),
  reauthRequestId: z.string().min(1).max(191),
  expectedGeneration: z.number().int().nonnegative(),
  requestId: uiRequestIdSchema,
}).strict();
const providerExecutionApprovalUiSchema = z.object({
  appId: z.string().min(1).max(191),
  executionId: z.string().min(1).max(191),
  expectedGeneration: z.number().int().nonnegative(),
  bindingHash: z.string().regex(/^[0-9a-f]{64}$/),
  requestId: uiRequestIdSchema,
}).strict();

function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "payload는 올바른 JSON object여야 합니다.";
  if (error instanceof ZodError) {
    return error.issues.map((issue) => issue.message).join(" ");
  }
  return error instanceof Error ? error.message : "Fleet 요청을 처리하지 못했습니다.";
}

async function fleetApp(appId: string) {
  const app = await prisma.app.findFirst({
    where: { id: appId, ...visibleAppWhere },
    select: { id: true, slug: true, repoId: true },
  });
  if (!app) throw new Error("앱을 찾을 수 없습니다.");
  if (!app.repoId) throw new Error("GitHub numeric repo ID가 없어 Fleet 설정을 변경할 수 없습니다.");
  return { id: app.id, slug: app.slug, repoId: app.repoId };
}

async function fleetWriteContext(appId: string) {
  const app = await fleetApp(appId);
  const actor = await requirePlatformWriteAccess(app.slug);
  if (actor.appId !== app.id) throw new Error("Fleet 앱 권한 결합이 일치하지 않습니다.");
  return { app, actor };
}

function parsePayloadText(payloadText: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(payloadText);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("payload는 JSON object여야 합니다.");
  }
  return parsed as Record<string, unknown>;
}

/** UI와 internal API가 같은 Zod 계약을 사용하며 이 action은 저장하지 않는다. */
export async function validateFleetConfigDraftAction(input: {
  appId: string;
  expectedLatestRevision: number;
  payloadText: string;
}): Promise<FleetActionResult> {
  try {
    await requirePlatformReadAccess();
    const app = await fleetApp(input.appId);
    configRevisionSchema.parse({
      repoId: app.repoId,
      expectedLatestRevision: input.expectedLatestRevision,
      payload: parsePayloadText(input.payloadText),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function createFleetConfigDraftAction(input: {
  appId: string;
  expectedLatestRevision: number;
  payloadText: string;
  requestId: string;
}): Promise<FleetActionResult> {
  try {
    const { app, actor } = await fleetWriteContext(input.appId);
    const body = configRevisionSchema.parse({
      repoId: app.repoId,
      expectedLatestRevision: input.expectedLatestRevision,
      payload: parsePayloadText(input.payloadText),
    });
    const result = await createConfigRevision({
      ...body,
      actor: actor.login,
      idempotencyKey: `ui-config-create:${uiRequestIdSchema.parse(input.requestId)}`,
    });
    revalidatePath(`/apps/${app.id}/fleet`);
    return { ok: true, revision: result.revision.revision, status: result.revision.status };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function importLegacyShadowAction(input: {
  appId: string;
  sourceSha: string;
  requestId: string;
}): Promise<FleetActionResult> {
  try {
    const { app, actor } = await fleetWriteContext(input.appId);
    const body = legacyShadowImportRequestSchema.parse({
      repoId: app.repoId,
      sourceSha: input.sourceSha,
    });
    const result = await recordLegacyShadowImport({
      ...body,
      observedBy: actor.login,
      idempotencyKey: `ui-legacy-shadow:${uiRequestIdSchema.parse(input.requestId)}`,
    });
    revalidatePath(`/apps/${app.id}/fleet`);
    return {
      ok: true,
      importId: result.import.id,
      revision: result.configRevision?.revision,
      status: result.import.status,
      parityStatus: result.parity?.status ?? null,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function activateFleetConfigRevisionAction(input: {
  appId: string;
  revision: number;
  expectedActiveRevision: number;
  requestId: string;
}): Promise<FleetActionResult> {
  try {
    const { app, actor } = await fleetWriteContext(input.appId);
    const body = configActivationSchema.parse({
      repoId: app.repoId,
      revision: input.revision,
      expectedActiveRevision: input.expectedActiveRevision,
    });
    const result = await activateConfigRevision({
      ...body,
      actor: actor.login,
      idempotencyKey: `ui-config-activate:${uiRequestIdSchema.parse(input.requestId)}`,
      signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
    });
    revalidatePath(`/apps/${app.id}/fleet`);
    return { ok: true, revision: result.revision.revision, status: result.revision.status };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function markTrustedLocalPendingAction(input: {
  appId: string;
  reauthRequestId: string;
  expectedGeneration: number;
  requestId: string;
}): Promise<FleetActionResult> {
  try {
    const body = trustedLocalHumanUiSchema.parse(input);
    const { app, actor } = await fleetWriteContext(body.appId);
    const result = await markReauthTrustedLocalPendingFromHumanUi({
      repoId: app.repoId,
      reauthRequestId: body.reauthRequestId,
      expectedGeneration: body.expectedGeneration,
      actor: actor.login,
      idempotencyKey: `ui-reauth-pending:${body.requestId}`,
    });
    revalidatePath(`/apps/${app.id}/fleet`);
    return { ok: true, status: result.request.status };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * IDEA~RELEASE_ASSETS 구간의 사람 전이다. 한 단계 전진만 허용하며
 * 되돌림·건너뜀·라벨 기반 전이는 정책에서 거부한다.
 */
export async function advanceFleetLifecycleStageAction(input: {
  appId: string;
  toStage: string;
  expectedGeneration: number;
  requestId: string;
}): Promise<FleetActionResult> {
  try {
    const { app, actor } = await fleetWriteContext(input.appId);
    const body = fleetLifecycleHumanTransitionSchema.parse({
      repoId: app.repoId,
      toStage: input.toStage,
      expectedGeneration: input.expectedGeneration,
    });
    const result = await advanceFleetLifecycleStageFromHumanUi({
      ...body,
      actor: actor.login,
      idempotencyKey: `ui-lifecycle-advance:${uiRequestIdSchema.parse(input.requestId)}`,
    });
    revalidatePath(`/apps/${app.id}/fleet`);
    return {
      ok: true,
      stage: result.state?.stage,
      generation: result.state?.generation,
      status: result.duplicate ? "DUPLICATE" : "ADVANCED",
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function approveProviderExecutionAction(input: {
  appId: string;
  executionId: string;
  expectedGeneration: number;
  bindingHash: string;
  requestId: string;
}): Promise<FleetActionResult> {
  try {
    const body = providerExecutionApprovalUiSchema.parse(input);
    const { app, actor } = await fleetWriteContext(body.appId);
    const execution = await prisma.providerExecution.findFirst({
      where: { id: body.executionId, appId: app.id },
      select: { id: true },
    });
    if (!execution) throw new Error("앱 범위의 provider execution을 찾을 수 없습니다.");
    const result = await approveProviderExecution({
      executionId: body.executionId,
      expectedGeneration: body.expectedGeneration,
      bindingHash: body.bindingHash,
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
      actor: actor.login,
      idempotencyKey: `ui-provider-approve:${body.requestId}`,
    });
    revalidatePath(`/apps/${app.id}/fleet`);
    return { ok: true, status: result.duplicate ? "APPROVED" : "QUEUED" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function createFleetAutomationAction(input: {
  appId: string;
  template: string;
  agentKind: string;
  cadence: string;
  approvalPolicy: string;
  budgetCeilingMicros: number;
  model?: string;
  maxAttempts: number;
  requestId: string;
}): Promise<FleetActionResult> {
  try {
    const { app, actor } = await fleetWriteContext(input.appId);
    const body = automationDefinitionCreateSchema.parse({
      repoId: app.repoId,
      template: input.template,
      agentKind: input.agentKind,
      cadence: input.cadence,
      approvalPolicy: input.approvalPolicy,
      budgetCeilingMicros: input.budgetCeilingMicros,
      model: input.model || undefined,
      maxAttempts: input.maxAttempts,
    });
    const requestId = uiRequestIdSchema.parse(input.requestId);
    const result = await createAutomationDefinition({
      ...body,
      actor: actor.login,
      idempotencyKey: `ui-automation-create:${requestId}`,
    });
    if (body.cadence === "MANUAL") {
      await executeAutomationCommand({
        definitionId: result.definition.id,
        command: { command: "RUN_NOW" },
        actor: actor.login,
        requestId: `ui-automation-now:${requestId}`,
      });
    }
    revalidatePath(`/apps/${app.id}/fleet`);
    return {
      ok: true,
      definitionId: result.definition.id,
      status: body.cadence === "MANUAL" ? "RUN_REQUESTED" : "ACTIVE",
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function commandFleetAutomationAction(input: {
  appId: string;
  definitionId: string;
  command: string;
  runId?: string;
  requestId: string;
}): Promise<FleetActionResult> {
  try {
    const { app, actor } = await fleetWriteContext(input.appId);
    const definition = await prisma.automationDefinition.findUnique({
      where: { id: input.definitionId },
      select: { appId: true },
    });
    if (definition?.appId !== app.id) throw new Error("routine과 앱 권한 결합이 일치하지 않습니다.");
    const command = automationDefinitionCommandSchema.parse({
      command: input.command,
      ...(input.runId ? { runId: input.runId } : {}),
    });
    await executeAutomationCommand({
      definitionId: input.definitionId,
      command,
      actor: actor.login,
      requestId: `ui-automation-command:${uiRequestIdSchema.parse(input.requestId)}`,
    });
    revalidatePath(`/apps/${app.id}/fleet`);
    return { ok: true, status: command.command };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
