import { NextRequest, NextResponse } from "next/server";
import { configActivationSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";
import { activateConfigRevision } from "@/lib/control-plane/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try {
    const body = configActivationSchema.parse(await request.json());
    const result = await activateConfigRevision({
      ...body,
      actor: principal.id,
      idempotencyKey,
      signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
    });
    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      id: result.revision.id,
      revision: result.revision.revision,
      status: result.revision.status,
      snapshotDigest: result.revision.snapshotDigest,
      snapshotSignature: result.revision.snapshotSignature,
    });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}

