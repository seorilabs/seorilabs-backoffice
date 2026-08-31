import { NextRequest, NextResponse } from "next/server";

import { fleetCleanupCapabilityRequestSchema } from "@/lib/control-plane/fleet-cleanup-capability-contract";
import { authenticateFleetCleanupGithubActionsRequest } from "@/lib/control-plane/fleet-cleanup-github-actions-oidc";
import {
  approveFleetCleanupCapability,
  executeFleetCleanupCapability,
} from "@/lib/control-plane/fleet-cleanup-service";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import {
  authenticateInternalRequest,
  requireIdempotencyKey,
} from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  }
  try {
    const rawBody = await request.json();
    const body = fleetCleanupCapabilityRequestSchema.parse(rawBody);
    if (body.operation === "ISSUE") {
      const principal = authenticateInternalRequest(request, "control-plane");
      if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      return NextResponse.json({
        ok: true,
        capability: await approveFleetCleanupCapability({
          requestId: idempotencyKey,
          approvedBy: principal.id,
          body,
        }),
      });
    }
    if (idempotencyKey !== `fleet-cleanup-execute:${body.capabilityId}`) {
      return NextResponse.json({ error: "capability-bound Idempotency-Key required" }, { status: 400 });
    }
    const identity = await authenticateFleetCleanupGithubActionsRequest({
      request,
      expectedRunId: body.runId,
      expectedRunAttempt: body.runAttempt,
    });
    if (!identity) return NextResponse.json({ error: "trusted cleanup executor OIDC required" }, { status: 401 });
    return NextResponse.json({
      ...await executeFleetCleanupCapability({
        executorIdentity: identity,
        body,
      }),
    });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
