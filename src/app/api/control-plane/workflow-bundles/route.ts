import { NextRequest, NextResponse } from "next/server";

import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";
import {
  importWorkflowBundleApproval,
  importWorkflowBundleCandidate,
  publicWorkflowBundleRegistryRecord,
  workflowBundleImportSchema,
} from "@/lib/control-plane/workflow-bundle-v5-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  }
  try {
    const body = workflowBundleImportSchema.parse(await request.json());
    const result = body.mode === "CANDIDATE"
      ? await importWorkflowBundleCandidate({
          sourceSha: body.sourceSha.toLowerCase(),
          runId: body.runId,
          runAttempt: body.runAttempt,
          artifactId: body.artifactId,
          idempotencyKey,
          actor: principal.id,
        })
      : await importWorkflowBundleApproval({
          bundle: body.bundle,
          idempotencyKey,
          actor: principal.id,
        });
    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      record: publicWorkflowBundleRegistryRecord(result.record),
    }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
