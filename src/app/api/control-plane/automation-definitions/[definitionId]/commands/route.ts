import { NextRequest, NextResponse } from "next/server";

import { executeAutomationCommand } from "@/lib/control-plane/automation-service";
import { automationDefinitionCommandSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ definitionId: string }> },
) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try {
    const { definitionId } = await context.params;
    const command = automationDefinitionCommandSchema.parse(await request.json());
    const result = await executeAutomationCommand({
      definitionId,
      command,
      actor: principal.id,
      requestId: idempotencyKey,
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
