import { NextRequest, NextResponse } from "next/server";

import {
  fleetStandardLabelRequestSchema,
} from "@/lib/control-plane/fleet-standard-labels";
import {
  applyFleetStandardLabels,
  getFleetStandardLabelStatus,
  planFleetStandardLabels,
} from "@/lib/control-plane/fleet-standard-label-service";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function GET(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await getFleetStandardLabelStatus());
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
    const body = fleetStandardLabelRequestSchema.parse(await request.json());
    const result = body.mode === "PLAN"
      ? await planFleetStandardLabels({ actor: principal.id, idempotencyKey })
      : await applyFleetStandardLabels({
          actor: principal.id,
          idempotencyKey,
          planId: body.planId,
          planDigest: body.planDigest,
        });
    return NextResponse.json(result, {
      status: result.mode === "PLAN" ? 201 : result.state === "busy" ? 409 : result.state === "partial" ? 207 : 200,
    });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
