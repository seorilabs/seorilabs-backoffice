"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import {
  configActivationSchema,
  configRevisionSchema,
} from "@/lib/control-plane/contracts";
import {
  activateConfigRevision,
  createConfigRevision,
  markReauthTrustedLocalPending,
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
}

const uiRequestIdSchema = z.string().uuid();

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
  payloadText: string;
}): Promise<FleetActionResult> {
  try {
    await requirePlatformReadAccess();
    const app = await fleetApp(input.appId);
    configRevisionSchema.parse({ repoId: app.repoId, payload: parsePayloadText(input.payloadText) });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function createFleetConfigDraftAction(input: {
  appId: string;
  payloadText: string;
  requestId: string;
}): Promise<FleetActionResult> {
  try {
    const { app, actor } = await fleetWriteContext(input.appId);
    const body = configRevisionSchema.parse({
      repoId: app.repoId,
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
    const { app, actor } = await fleetWriteContext(input.appId);
    const result = await markReauthTrustedLocalPending({
      repoId: app.repoId,
      reauthRequestId: input.reauthRequestId,
      expectedGeneration: input.expectedGeneration,
      actor: actor.login,
      idempotencyKey: `ui-reauth-pending:${uiRequestIdSchema.parse(input.requestId)}`,
    });
    revalidatePath(`/apps/${app.id}/fleet`);
    return { ok: true, status: result.request.status };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
