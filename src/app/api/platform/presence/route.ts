import { NextResponse } from "next/server";

import { loadPlatformPresenceSnapshot } from "@/lib/platform/presence";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({
      ok: true,
      snapshot: await loadPlatformPresenceSnapshot(),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "presence 집계를 읽지 못했습니다." },
      { status: 503 },
    );
  }
}
