import { NextResponse } from "next/server";

import { requeueExpiredLeases } from "@/lib/control-plane/agent-queue";
import { reconcileAutomationScheduler } from "@/lib/control-plane/automation-service";
import { verifyStaticToken } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const now = new Date();
  await requeueExpiredLeases(now);
  const result = await reconcileAutomationScheduler({ now });
  return NextResponse.json({ ok: true, result });
}
