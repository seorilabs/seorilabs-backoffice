import { NextRequest, NextResponse } from "next/server";

import { configRevisionDiscoveryDraftSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";
import { createDiscoveryProjectedConfigRevision } from "@/lib/control-plane/service";

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
    const body = configRevisionDiscoveryDraftSchema.parse(await request.json());
    const result = await createDiscoveryProjectedConfigRevision({
      ...body,
      actor: principal.id,
      idempotencyKey,
    });
    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      id: result.revision.id,
      revision: result.revision.revision,
      status: result.revision.status,
      payloadHash: result.revision.payloadHash,
      sourceObservationId: result.sourceObservation.id,
      sourceSha: result.sourceObservation.sourceSha,
      legacyPayloadCopied: false,
      mode: body.mode,
      activationAttempted: false,
    }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
