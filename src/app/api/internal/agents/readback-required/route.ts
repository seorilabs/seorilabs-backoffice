import { NextRequest, NextResponse } from "next/server";

import { settleAgentRun } from "@/lib/control-plane/agent-queue";
import { refreshRunFleetProjection } from "@/lib/control-plane/automation-service";
import { agentReadbackRequiredSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "agent-worker");
  if (!principal?.runtimeBindingDigest) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try {
    const body = agentReadbackRequiredSchema.parse(await request.json());
    const result = await settleAgentRun({
      ...body,
      workerId: principal.id,
      runtimeBindingDigest: principal.runtimeBindingDigest,
      outcome: "unknown",
      idempotencyKey,
    });
    await refreshRunFleetProjection(result.runId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
