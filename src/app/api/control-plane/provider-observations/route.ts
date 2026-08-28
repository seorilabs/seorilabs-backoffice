import { NextRequest, NextResponse } from "next/server";
import {
  platformConsumerObservationPayloadSchema,
  providerObservationSchema,
} from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";
import { ControlPlaneError, recordProviderObservation } from "@/lib/control-plane/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try {
    const body = providerObservationSchema.parse(await request.json());
    const isPlatformConsumer = body.provider.toLowerCase() === "platform"
      && body.resourceType === "platform-consumer";
    if (isPlatformConsumer && body.resourceId !== body.repoId.toString()) {
      throw new ControlPlaneError(
        "Platform consumer observation은 numeric repo ID에 고정되어야 합니다.",
        409,
        "PLATFORM_PROVIDER_IDENTITY_MISMATCH",
      );
    }
    const normalizedBody = isPlatformConsumer
      ? { ...body, payload: platformConsumerObservationPayloadSchema.parse(body.payload) }
      : body;
    const result = await recordProviderObservation({
      ...normalizedBody,
      observedBy: principal.id,
      idempotencyKey,
    });
    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      observationId: result.observation.id,
      payloadHash: result.observation.payloadHash,
    }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
