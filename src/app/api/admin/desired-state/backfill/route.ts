import { NextResponse } from "next/server";

import { runDesiredStateDraftBackfill } from "@/lib/control-plane/desired-state-backfill";
import { verifyStaticToken } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

function hourlyIdempotencyKey(now: Date): string {
  return `desired-state-backfill:${now.toISOString().slice(0, 13).replace(/[-T:]/g, "")}`;
}

export async function POST(request: Request) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runDesiredStateDraftBackfill({
      actor: "scheduler:desired-state-backfill",
      idempotencyKey: hourlyIdempotencyKey(new Date()),
    });
    return NextResponse.json(result, {
      status: result.state === "busy" ? 409 : result.ok ? 200 : 500,
    });
  } catch {
    console.error("[admin/desired-state/backfill] 실패 code=BACKFILL_FAILED");
    return NextResponse.json({ error: "desired-state backfill failed" }, { status: 500 });
  }
}
