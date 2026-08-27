import { NextRequest, NextResponse } from "next/server";
import { agentLeaseActionSchema } from "@/lib/control-plane/contracts";
import { settleAgentRun } from "@/lib/control-plane/agent-queue";
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
    const body = agentLeaseActionSchema.parse(await request.json());
    return NextResponse.json({
      ok: true,
      ...(await settleAgentRun({ ...body, workerId: principal.id, outcome: "fail", idempotencyKey })),
    });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
