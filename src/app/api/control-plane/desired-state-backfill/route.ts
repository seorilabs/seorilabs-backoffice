import { NextRequest, NextResponse } from "next/server";

import { desiredStateBackfillSchema } from "@/lib/control-plane/contracts";
import {
  desiredStateBackfillReadbackHeaders,
  getDesiredStateBackfillSummary,
  runDesiredStateDraftBackfill,
} from "@/lib/control-plane/desired-state-backfill";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function GET(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await getDesiredStateBackfillSummary());
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
    desiredStateBackfillSchema.parse(await request.json());
    const result = await runDesiredStateDraftBackfill({
      actor: principal.id,
      idempotencyKey,
      trigger: "CONTROL_PLANE_API",
      sourceSha: null,
    }, {
      signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
    });
    return NextResponse.json(result, {
      status: result.state === "busy" ? 409 : result.duplicate ? 200 : 201,
      headers: desiredStateBackfillReadbackHeaders(result),
    });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
