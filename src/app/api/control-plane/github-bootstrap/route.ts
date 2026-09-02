import { NextRequest, NextResponse } from "next/server";
import { authenticateInternalRequest } from "@/lib/control-plane/security";
import { productionGitHubBootstrapAdapter } from "@/lib/control-plane/github-bootstrap-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** AI/operator diagnostics are read-only. Activation requires the authenticated human UI. */
export async function GET(request: NextRequest) {
  if (!authenticateInternalRequest(request, "control-plane")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ mode: "READ_ONLY", executionAllowed: false, plan: await (await productionGitHubBootstrapAdapter()).plan() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "GITHUB_BOOTSTRAP_READBACK_FAILED", executionAllowed: false }, { status: 503 });
  }
}
