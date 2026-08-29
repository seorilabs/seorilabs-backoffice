import { NextRequest, NextResponse } from "next/server";

import {
  fleetProjectBindingDesiredStateSchema,
  getFleetProjectBinding,
  setFleetProjectBindingDesiredState,
} from "@/lib/control-plane/fleet-project-binding";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import {
  authenticateInternalRequest,
  requireIdempotencyKey,
} from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, binding: await getFleetProjectBinding() });
}

export async function PUT(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  }
  try {
    const desired = fleetProjectBindingDesiredStateSchema.parse(await request.json());
    const result = await setFleetProjectBindingDesiredState({
      desired,
      actor: principal.id,
      idempotencyKey,
    });
    return NextResponse.json({ ok: true, ...result }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
