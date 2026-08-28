import { NextRequest, NextResponse } from "next/server";
import { releaseGateObservationSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { recordReleaseGateObservation } from "@/lib/control-plane/release-ledger";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try {
    const body = releaseGateObservationSchema.parse(await request.json());
    const result = await recordReleaseGateObservation({
      ...body,
      actor: principal.id,
      idempotencyKey,
    });
    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      observationId: result.observation.id,
    }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
