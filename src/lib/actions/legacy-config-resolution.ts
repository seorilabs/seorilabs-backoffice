"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import {
  legacyConfigResolutionRequestSchema,
  type LegacyConfigResolutionRequest,
} from "@/lib/control-plane/contracts";
import {
  LEGACY_RESOLUTION_BATCH_LIMIT,
} from "@/lib/control-plane/legacy-config-resolution-selection";
import {
  prepareFleetLegacyResolutionBatch,
  type FleetLegacyResolutionBatchSelection,
} from "@/lib/control-plane/fleet-legacy-resolution-batch";
import { getFleetLegacyResolutionQueue } from "@/lib/control-plane/fleet-legacy-resolution-queue";
import { recordLegacyConfigResolution } from "@/lib/control-plane/legacy-config-resolution-service";
import { requirePlatformReadAccess } from "@/lib/platform/access";

const requestIdSchema = z.string().uuid();
const batchSelectionSchema = z.object({
  appId: z.string().min(1).max(191),
  repoId: z.string().regex(/^\d+$/).max(16),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  legacyImportId: z.string().min(1).max(191),
  expectedActiveConfigRevision: z.number().int().positive(),
  expectedResolutionRevision: z.number().int().nonnegative(),
  requestId: requestIdSchema,
}).strict();
const batchRequestSchema = z.object({
  items: z.array(batchSelectionSchema).min(1).max(LEGACY_RESOLUTION_BATCH_LIMIT),
}).strict();

export interface LegacyConfigResolutionActionResult {
  ok: boolean;
  error?: string;
  revision?: number;
}

export interface LegacyConfigResolutionBatchActionResult {
  ok: boolean;
  completedCount: number;
  failedCount: number;
  error?: string;
  results: Array<{
    appId: string;
    repoFullName: string;
    ok: boolean;
    revision?: number;
    error?: string;
  }>;
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

/**
 * 중앙 queue에서 사람이 한 번 확인한 여러 앱을 같은 요청으로 소진한다.
 * 각 앱은 기존 Serializable transaction, optimistic revision, append-only audit를 그대로
 * 사용한다. 실행 전 전체 exact vector를 검증하고, 실행 중 race가 난 항목만 실패로 남긴다.
 */
export async function approveLegacyConfigResolutionBatchAction(input: {
  items: FleetLegacyResolutionBatchSelection[];
}): Promise<LegacyConfigResolutionBatchActionResult> {
  try {
    const actor = await requirePlatformReadAccess();
    if (actor.role !== "ADMIN") throw new Error("Legacy 설정 일괄 대체 승인은 ADMIN만 할 수 있습니다.");
    const body = batchRequestSchema.parse(input);
    const prepared = prepareFleetLegacyResolutionBatch({
      queue: await getFleetLegacyResolutionQueue(),
      selections: body.items,
    });
    const results: LegacyConfigResolutionBatchActionResult["results"] = [];
    for (const item of prepared) {
      try {
        const result = await recordLegacyConfigResolution({
          request: item.request,
          actor: actor.login,
          approvalKind: "HUMAN",
          idempotencyKey: `ui-legacy-config-resolution:${item.requestId}`,
        });
        results.push({
          appId: item.appId,
          repoFullName: item.repoFullName,
          ok: true,
          revision: result.resolution.revision,
        });
      } catch (error) {
        results.push({
          appId: item.appId,
          repoFullName: item.repoFullName,
          ok: false,
          error: errorMessage(error),
        });
      }
    }
    for (const item of prepared) revalidatePath(`/apps/${item.appId}/fleet`);
    revalidatePath("/settings");
    const failedCount = results.filter((result) => !result.ok).length;
    return {
      ok: failedCount === 0,
      completedCount: results.length - failedCount,
      failedCount,
      results,
      ...(failedCount > 0
        ? { error: "일부 항목의 중앙 상태가 실행 중 변경되었습니다. 성공 항목은 유지되며 실패 항목만 다시 검토하세요." }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      completedCount: 0,
      failedCount: 0,
      error: errorMessage(error),
      results: [],
    };
  }
}
