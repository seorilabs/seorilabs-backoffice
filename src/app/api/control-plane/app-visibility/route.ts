import { NextRequest, NextResponse } from "next/server";
import { appVisibilitySchema, setAppVisibility } from "@/lib/control-plane/app-visibility-service";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({error: "unauthorized"}, {status: 401});
  const requestId = requireIdempotencyKey(request);
  if (!requestId) return NextResponse.json({error: "valid Idempotency-Key required"}, {status: 400});
  try {
    const body = appVisibilitySchema.parse(await request.json());
    const result = await setAppVisibility({...body, requestId, actor: {kind: "internal", principal}});
    return NextResponse.json({ok: true, ...result});
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
