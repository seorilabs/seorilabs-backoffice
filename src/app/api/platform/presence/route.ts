import { NextResponse } from "next/server";

import { loadPresenceApiResult } from "@/lib/platform/presence-api";
import { loadPlatformPresencePipelineSnapshot } from "@/lib/platform/presence-pipeline";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await loadPresenceApiResult(
    loadPlatformPresencePipelineSnapshot,
  );
  return NextResponse.json(result.body, { status: result.status });
}
