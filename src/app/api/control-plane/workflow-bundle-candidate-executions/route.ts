import { NextRequest, NextResponse } from "next/server";

import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";
import {
  workflowBundleCandidateExecutionRequestSchema,
} from "@/lib/control-plane/workflow-bundle-candidate-contract";
import {
  enqueueWorkflowBundleCandidateExecution,
  planWorkflowBundleCandidateExecution,
  readWorkflowBundleCandidateRun,
} from "@/lib/control-plane/workflow-bundle-candidate-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runId = request.nextUrl.searchParams.get("runId")?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/u.test(runId)) {
    return NextResponse.json({ error: "valid runId required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await readWorkflowBundleCandidateRun(runId), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  }
  try {
    const body = workflowBundleCandidateExecutionRequestSchema.parse(await request.json());
    const common = {
      workflowBundleRecordId: body.workflowBundleRecordId,
      repositoryId: body.repositoryId,
      sourceSha: body.sourceSha.toLowerCase(),
      issueNumber: body.issueNumber,
    };
    const result = body.mode === "PLAN"
      ? await planWorkflowBundleCandidateExecution(common)
      : await enqueueWorkflowBundleCandidateExecution({
          ...common,
          actor: principal.id,
          idempotencyKey,
        });
    return NextResponse.json(result, { status: body.mode === "PLAN" ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
