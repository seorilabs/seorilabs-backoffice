import { NextRequest, NextResponse } from "next/server";

import { legacyConfigResolutionRequestSchema } from "@/lib/control-plane/contracts";
import {
  listLegacyConfigResolutions,
  recordLegacyConfigResolution,
} from "@/lib/control-plane/legacy-config-resolution-service";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const repoId = BigInt(request.nextUrl.searchParams.get("repoId") ?? "0");
    if (repoId <= 0n || repoId > BigInt(Number.MAX_SAFE_INTEGER)) {
      return NextResponse.json({ error: "valid repoId required" }, { status: 400 });
    }
    return NextResponse.json(await listLegacyConfigResolutions({ repoId }));
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
    const body = legacyConfigResolutionRequestSchema.parse(await request.json());
    const result = await recordLegacyConfigResolution({
      request: body,
      actor: principal.id,
      approvalKind: "AUTOMATION",
      idempotencyKey,
    });
    return NextResponse.json({ ok: true, ...result }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
