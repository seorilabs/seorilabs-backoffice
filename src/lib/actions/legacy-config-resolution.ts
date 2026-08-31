"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import {
  legacyConfigResolutionRequestSchema,
  type LegacyConfigResolutionRequest,
} from "@/lib/control-plane/contracts";
import { recordLegacyConfigResolution } from "@/lib/control-plane/legacy-config-resolution-service";
import { requirePlatformReadAccess } from "@/lib/platform/access";

const requestIdSchema = z.string().uuid();

export interface LegacyConfigResolutionActionResult {
  ok: boolean;
  error?: string;
  revision?: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((issue) => issue.message).join(" ");
  return error instanceof Error ? error.message : "Legacy 설정 검토 결과를 저장하지 못했습니다.";
}

export async function approveLegacyConfigResolutionAction(input: {
  appId: string;
  request: Omit<LegacyConfigResolutionRequest, "repoId"> & { repoId: string };
  requestId: string;
}): Promise<LegacyConfigResolutionActionResult> {
  try {
    const actor = await requirePlatformReadAccess();
    if (actor.role !== "ADMIN") throw new Error("Legacy 설정 대체 승인은 ADMIN만 할 수 있습니다.");
    const request = legacyConfigResolutionRequestSchema.parse(input.request);
    const result = await recordLegacyConfigResolution({
      request,
      actor: actor.login,
      approvalKind: "HUMAN",
      idempotencyKey: `ui-legacy-config-resolution:${requestIdSchema.parse(input.requestId)}`,
    });
    revalidatePath(`/apps/${input.appId}/fleet`);
    return { ok: true, revision: result.resolution.revision };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
