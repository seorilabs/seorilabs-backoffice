import { NextRequest, NextResponse } from "next/server";

import { platformFleetReconcileSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { reconcilePlatformFleet } from "@/lib/control-plane/platform-fleet";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try {
    const body = platformFleetReconcileSchema.parse(await request.json());
    const result = await reconcilePlatformFleet({
      ...body,
      actor: principal.id,
      idempotencyKey,
      signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
