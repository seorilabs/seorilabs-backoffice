import { NextRequest, NextResponse } from "next/server";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { configureMetricRegistration, registrationConfigurationSchema, REGISTRATION_KEY } from "@/lib/metric-issues/queue";
import { prisma } from "@/lib/prisma";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  if (!authenticateInternalRequest(request, "control-plane")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const definition = await prisma.automationDefinition.findUnique({ where: { key: REGISTRATION_KEY } });
  return NextResponse.json({ enabled: definition?.enabled ?? false, updatedAt: definition?.updatedAt.toISOString() ?? null, configuration: definition?.configuration ?? { maxElapsedMs: 600000, maxTokens: 40000 } });
}
export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const requestId = requireIdempotencyKey(request);
  if (!requestId) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try { return NextResponse.json(await configureMetricRegistration({ ...registrationConfigurationSchema.parse(await request.json()), actor: principal.id, requestId })); }
  catch (error) { return controlPlaneErrorResponse(error); }
}
