import { NextResponse } from "next/server";
import { reconcileAll } from "@/lib/sync/backfill";
import { computeReconcile } from "@/lib/sync/reconcile-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(request: Request) {
  const result = await computeReconcile(
    request.headers.get("x-admin-token"),
    process.env.INTERNAL_ADMIN_TOKEN,
    reconcileAll,
  );
  return NextResponse.json(result.body, { status: result.status });
}
