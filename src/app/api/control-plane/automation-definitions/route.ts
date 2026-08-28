import { NextRequest, NextResponse } from "next/server";

import { createAutomationDefinition } from "@/lib/control-plane/automation-service";
import { automationDefinitionCreateSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try {
    const body = automationDefinitionCreateSchema.parse(await request.json());
    const result = await createAutomationDefinition({
      ...body,
      actor: principal.id,
      idempotencyKey,
    });
    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      definition: {
        id: result.definition.id,
        key: result.definition.key,
        template: result.definition.template,
        agentKind: result.definition.agentKind,
        schedule: result.definition.schedule,
        approvalPolicy: body.approvalPolicy,
        budgetCeilingMicros: body.budgetCeilingMicros,
        model: result.definition.model,
        enabled: result.definition.enabled,
      },
    }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
