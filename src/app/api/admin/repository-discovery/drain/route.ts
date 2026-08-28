import { NextResponse } from "next/server";

import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { drainRepositoryDiscoveryQueue } from "@/lib/control-plane/repository-discovery-service";
import { verifyStaticToken } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(request: Request) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await drainRepositoryDiscoveryQueue({
      workerId: "scheduler:repository-discovery-drain",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
