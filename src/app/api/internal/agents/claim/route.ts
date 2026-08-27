import { NextRequest, NextResponse } from "next/server";
import { agentClaimSchema } from "@/lib/control-plane/contracts";
import { claimAgentRun } from "@/lib/control-plane/agent-queue";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "agent-worker");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try {
    const body = agentClaimSchema.parse(await request.json());
    if (body.workerId !== principal.id) {
      return NextResponse.json({ error: "worker identity mismatch" }, { status: 403 });
    }
    const claim = await claimAgentRun({
      ...body,
      idempotencyKey,
      signingKey: process.env.AGENT_LEASE_SIGNING_KEY ?? "",
    });
    return NextResponse.json({ ok: true, claim });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
