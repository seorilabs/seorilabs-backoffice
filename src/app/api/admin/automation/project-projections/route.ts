import { NextResponse } from "next/server";

import { reconcileFleetProjectProjections } from "@/lib/control-plane/fleet-projector";
import { verifyStaticToken } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    ...(await reconcileFleetProjectProjections()),
  });
}
