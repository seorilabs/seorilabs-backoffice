import { NextResponse } from "next/server";

import {
  desiredStateBackfillAdminInvocation,
  desiredStateBackfillReadbackHeaders,
  runDesiredStateDraftBackfill,
} from "@/lib/control-plane/desired-state-backfill";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { verifyStaticToken } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(request: Request) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const invocation = desiredStateBackfillAdminInvocation({
      trigger: request.headers.get("x-seorilabs-backfill-trigger"),
      sourceSha: request.headers.get("x-seorilabs-source-sha"),
      now: new Date(),
    });
    const result = await runDesiredStateDraftBackfill(invocation);
    return NextResponse.json(result, {
      status: result.state === "busy" ? 409 : result.ok ? 200 : 500,
      headers: desiredStateBackfillReadbackHeaders(result),
    });
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    console.error("[admin/desired-state/backfill] 실패 code=BACKFILL_FAILED");
    return NextResponse.json({ error: "desired-state backfill failed" }, { status: 500 });
  }
}
