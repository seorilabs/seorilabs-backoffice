import { NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { syncPendingXcodeCloudDeployments } from "@/lib/xcode-cloud/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await syncPendingXcodeCloudDeployments();
  return NextResponse.json({ ok: true, ...result });
}
