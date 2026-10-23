import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { verifyStaticToken } from "@/lib/security";
import { metricDayOf } from "@/lib/analytics/metric-day";
import { ingestBookSales, readBookSales } from "@/lib/book-sales/service";
import { handleBookSalesPost } from "@/lib/book-sales/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const result = await handleBookSalesPost(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN, () => req.text(), (raw) => ingestBookSales(raw));
  return NextResponse.json(result.body, { status: result.status });
}

export async function GET(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = new Date();
  try {
    const month = req.nextUrl.searchParams.get("month") ?? metricDayOf(now).slice(0, 7);
    return NextResponse.json({ ok: true, ...await readBookSales(month, now) });
  } catch (error) {
    const invalid = error instanceof ZodError || error instanceof Error && error.message === "BOOK_SALES_FUTURE_MONTH";
    return NextResponse.json({ error: invalid ? "invalid month" : "book sales read failed" }, { status: invalid ? 400 : 500 });
  }
}
