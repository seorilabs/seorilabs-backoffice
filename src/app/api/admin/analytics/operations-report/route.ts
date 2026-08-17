import { NextRequest, NextResponse } from "next/server";
import { sendOperationsSummary } from "@/lib/core/operations-report";
import { verifyStaticToken } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  if (!verifyStaticToken(request.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await sendOperationsSummary(new Date())) });
  } catch (error) {
    console.error("[admin/analytics/operations-report] 실패:", error);
    return NextResponse.json({ error: "operations report failed" }, { status: 500 });
  }
}
