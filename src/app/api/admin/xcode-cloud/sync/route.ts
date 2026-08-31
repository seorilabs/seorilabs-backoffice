import { NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { syncPendingXcodeCloudDeployments } from "@/lib/xcode-cloud/status";
import { syncXcodeCloudPublicBindings } from "@/lib/xcode-cloud/public-binding";
import { scheduledRunHttpStatus } from "@/lib/sync/scheduler-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const bindings = await syncXcodeCloudPublicBindings();
  const releases = await syncPendingXcodeCloudDeployments();
  const failed = bindings.failed + releases.failed;
  const result = {
    ...releases,
    failed,
    state: failed === 0 && releases.state === "completed" ? "completed" as const : "partial" as const,
    ok: failed === 0 && releases.ok,
    bindings,
  };
  return NextResponse.json(result, { status: scheduledRunHttpStatus(result) });
}
