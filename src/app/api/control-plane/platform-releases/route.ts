import { NextRequest, NextResponse } from "next/server";

import { platformReleaseEnvelopeSchema } from "@/lib/control-plane/contracts";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { recordPlatformRelease } from "@/lib/control-plane/platform-fleet";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const releases = await prisma.platformRelease.findMany({
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    take: 50,
    select: {
      id: true,
      version: true,
      sourceSha: true,
      classification: true,
      approval: true,
      contractRevision: true,
      manifestDigest: true,
      publishedAt: true,
      observedBy: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ ok: true, releases });
}

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try {
    const body = platformReleaseEnvelopeSchema.parse(await request.json());
    const result = await recordPlatformRelease({
      ...body,
      actor: principal.id,
      idempotencyKey,
      signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
    });
    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      releaseId: result.release.id,
      version: result.release.version,
      manifestDigest: result.release.manifestDigest,
      approval: result.release.approval,
    }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
