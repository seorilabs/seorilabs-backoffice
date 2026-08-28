import { NextRequest, NextResponse } from "next/server";

import { providerExecutionCreateSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { enqueueProviderExecution } from "@/lib/control-plane/provider-execution-service";
import {
  authenticateInternalRequest,
  requireIdempotencyKey,
} from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try {
    const body = providerExecutionCreateSchema.parse(await request.json());
    const result = await enqueueProviderExecution({ ...body, actor: principal.id, idempotencyKey });
    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      execution: {
        id: result.execution.id,
        status: result.execution.status,
        bindingHash: result.execution.bindingHash,
        repoId: result.execution.repoId.toString(),
        sourceSha: result.execution.sourceSha,
        configRevision: result.execution.configRevisionNumber,
        provider: result.execution.provider,
        resourceType: result.execution.resourceType,
        resourceId: result.execution.resourceId,
        desiredHash: result.execution.desiredHash,
        publicAccountId: result.execution.publicAccountId,
        expectedPublicIdentity: result.execution.expectedPublicIdentity,
        logicalCredentialId: result.execution.logicalCredentialId,
        capability: result.execution.capability,
        actionClass: result.execution.actionClass,
      },
    }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
