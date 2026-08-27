import { NextRequest, NextResponse } from "next/server";

import { reauthRequestSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import {
  authenticateInternalRequest,
  requireIdempotencyKey,
} from "@/lib/control-plane/security";
import {
  listReauthRequests,
  recordReauthRequest,
} from "@/lib/control-plane/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const rawRepoId = request.nextUrl.searchParams.get("repoId") ?? "";
    if (!/^[1-9][0-9]*$/.test(rawRepoId)) {
      return NextResponse.json({ error: "invalid repoId" }, { status: 400 });
    }
    const repoId = BigInt(rawRepoId);
    return NextResponse.json({ ok: true, requests: await listReauthRequests(repoId) });
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
    const body = reauthRequestSchema.parse(await request.json());
    const result = await recordReauthRequest({
      ...body,
      actor: principal.id,
      idempotencyKey,
    });
    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      id: result.request.id,
      status: result.request.status,
      generation: result.request.generation,
    }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
