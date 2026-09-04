import { NextRequest, NextResponse } from "next/server";

import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";
import {
  importWorkflowBundleApproval,
  importWorkflowBundleCandidate,
  publicWorkflowBundleRegistryRecord,
  readWorkflowBundleRegistryRecords,
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

const SHA40 = /^[0-9a-f]{40}$/u;

// 승격 결과를 다시 읽는 경로. 공개 식별자와 digest만 반환하고 번들 본문은 내보내지 않는다.
export async function GET(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sourceSha = request.nextUrl.searchParams.get("sourceSha");
  if (sourceSha !== null && !SHA40.test(sourceSha)) {
    return NextResponse.json({ error: "invalid sourceSha" }, { status: 400 });
  }
  try {
    const records = await readWorkflowBundleRegistryRecords(sourceSha);
    return NextResponse.json({ records: records.map(publicWorkflowBundleRegistryRecord) });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
