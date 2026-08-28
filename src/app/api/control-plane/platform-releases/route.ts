import { NextRequest, NextResponse } from "next/server";

import { authenticateInternalRequest } from "@/lib/control-plane/security";
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
