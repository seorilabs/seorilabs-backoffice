"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { repositoryClassificationDecisionSchema } from "@/lib/control-plane/contracts";
import { recordRepositoryClassificationDecision } from "@/lib/control-plane/repository-classification-decision";
import { requirePlatformReadAccess } from "@/lib/platform/access";

const requestIdSchema = z.string().uuid();

export interface RepositoryClassificationActionResult {
  ok: boolean;
  error?: string;
  generation?: number | null;
  revision?: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((issue) => issue.message).join(" ");
  return error instanceof Error ? error.message : "Repository 분류를 저장하지 못했습니다.";
}

/** 사람 UI와 internal AI API가 같은 Zod 계약과 transaction service를 사용한다. */
export async function decideRepositoryClassificationAction(input: {
  repoId: string;
  expectedGeneration: number;
  expectedDecisionRevision: number;
  classification: "PRODUCT_APP" | "INFRA_REPO" | "PLATFORM_PRODUCER" | "EXCLUDED";
  candidateMarkerPath: string | null;
  justification: "REPOSITORY_PURPOSE_CONFIRMED" | "APP_CANDIDATE_SELECTED" | "CENTRAL_POLICY_CORRECTION";
  requestId: string;
}): Promise<RepositoryClassificationActionResult> {
  try {
    const actor = await requirePlatformReadAccess();
    if (actor.role !== "ADMIN") throw new Error("Repository 분류 변경은 ADMIN만 할 수 있습니다.");
    const request = repositoryClassificationDecisionSchema.parse({
      schemaVersion: 1,
      repoId: input.repoId,
      expectedGeneration: input.expectedGeneration,
      expectedDecisionRevision: input.expectedDecisionRevision,
      classification: input.classification,
      candidateMarkerPath: input.candidateMarkerPath,
      justification: input.justification,
    });
    const result = await recordRepositoryClassificationDecision({
      request,
      actor: actor.login,
      idempotencyKey: `ui-repository-classification:${requestIdSchema.parse(input.requestId)}`,
    });
    revalidatePath("/settings");
    return {
      ok: true,
      generation: result.generation,
      revision: result.decision.revision,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
