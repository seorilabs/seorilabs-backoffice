import { NextRequest, NextResponse } from "next/server";
import { ingestBatchResults } from "@/lib/operations-batches/service";
import { handleBatchPost } from "@/lib/operations-batches/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(req: NextRequest) {
  const result = await handleBatchPost(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN, () => req.text(), (raw) => ingestBatchResults(raw));
  return NextResponse.json(result.body, { status: result.status });
}
