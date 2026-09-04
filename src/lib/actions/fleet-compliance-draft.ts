"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";

import {
  fleetComplianceDraftBatchSchema,
  prepareFleetComplianceDraftBatch,
  type FleetComplianceDraftBatchSelection,
} from "@/lib/control-plane/fleet-compliance-draft-batch";
import { getFleetComplianceDraftQueueState } from "@/lib/control-plane/fleet-compliance-draft-queue";
import {
  activateConfigRevision,
  createConfigRevision,
} from "@/lib/control-plane/service";
import { requirePlatformWriteAccess } from "@/lib/platform/access";

export type FleetComplianceDraftBatchResultItem = {
  appId: string;
  repoFullName: string;
  ok: boolean;
  stage: "CREATE" | "ACTIVATE" | "COMPLETED";
  revision?: number;
  error?: string;
};

export type FleetComplianceDraftBatchActionResult = {
  ok: boolean;
  completedCount: number;
  results: FleetComplianceDraftBatchResultItem[];
  error?: string;
};

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((issue) => issue.message).join(" ");
  return error instanceof Error ? error.message : "Compliance 일괄 입력을 처리하지 못했습니다.";
}

export async function createAndActivateFleetComplianceDraftBatchAction(input: {
  items: FleetComplianceDraftBatchSelection[];
}): Promise<FleetComplianceDraftBatchActionResult> {
  try {
    const parsed = fleetComplianceDraftBatchSchema.parse(input);
    const prepared = prepareFleetComplianceDraftBatch({
      queue: await getFleetComplianceDraftQueueState({
        requestedCreateIdempotencyKeys: parsed.items.map(
          (item) => `ui-compliance-batch-create:${item.requestId}`,
        ),
      }),
      selections: parsed.items,
    });
    const signingKey = process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "";
    if (!signingKey) {
      throw new Error("서명된 ACTIVE snapshot을 만들 수 없어 Compliance 입력을 시작하지 않았습니다.");
    }

    const actorByAppId = new Map<string, string>();
    for (const item of prepared) {
      const actor = await requirePlatformWriteAccess(item.appSlug);
      if (actor.appId !== item.appId) {
        throw new Error("Compliance 입력 권한과 앱 identity가 일치하지 않습니다.");
      }
      actorByAppId.set(item.appId, actor.login);
    }

    const results: FleetComplianceDraftBatchResultItem[] = [];
    for (const item of prepared) {
      const actor = actorByAppId.get(item.appId)!;
      let revision: number | undefined;
      try {
        const created = await createConfigRevision({
          repoId: item.repoId,
          expectedLatestRevision: item.expectedLatestConfigRevision,
          expectedSourceSha: item.sourceSha,
          payload: item.payload,
          actor,
          idempotencyKey: `ui-compliance-batch-create:${item.requestId}`,
          draftIsolationAfterRevision: item.expectedActiveConfigRevision,
        });
        revision = created.revision.revision;
      } catch (error) {
        results.push({
          appId: item.appId,
          repoFullName: item.repoFullName,
          ok: false,
          stage: "CREATE",
          error: errorMessage(error),
        });
        continue;
      }

      try {
        const activated = await activateConfigRevision({
          repoId: item.repoId,
          revision,
          expectedActiveRevision: item.expectedActiveConfigRevision,
          actor,
          idempotencyKey: `ui-compliance-batch-activate:${item.requestId}`,
          signingKey,
          complianceDraftGuard: {
            createIdempotencyKey: `ui-compliance-batch-create:${item.requestId}`,
            afterRevision: item.expectedActiveConfigRevision,
          },
        });
        results.push({
          appId: item.appId,
          repoFullName: item.repoFullName,
          ok: true,
          stage: "COMPLETED",
          revision: activated.revision.revision,
        });
      } catch (error) {
        results.push({
          appId: item.appId,
          repoFullName: item.repoFullName,
          ok: false,
          stage: "ACTIVATE",
          revision,
          error: errorMessage(error),
        });
      }
      revalidatePath(`/apps/${item.appId}/fleet`);
    }
    revalidatePath("/settings");
    const completedCount = results.filter((result) => result.ok).length;
    return {
      ok: completedCount === results.length,
      completedCount,
      results,
      ...(completedCount === results.length
        ? {}
        : { error: "일부 앱의 Compliance revision이 완료되지 않았습니다. 단계별 결과를 확인하세요." }),
    };
  } catch (error) {
    return { ok: false, completedCount: 0, results: [], error: errorMessage(error) };
  }
}
