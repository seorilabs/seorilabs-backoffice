import { NextResponse } from "next/server";

import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { drainPlatformFleetPlans } from "@/lib/control-plane/platform-fleet";
import { producePlatformFleetRelease } from "@/lib/control-plane/platform-fleet-producer";
import { verifyStaticToken } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const producer = await producePlatformFleetRelease();
    const plans = await drainPlatformFleetPlans();
    return NextResponse.json({ ok: true, result: { producer, plans } });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
