import { NextRequest, NextResponse } from "next/server";
import { requirePlatformReadAccess } from "@/lib/platform/access";
import { parseMetricDay } from "@/lib/analytics/metric-day";
import { getOrgReport } from "@/lib/core/org-report";
import { dailyReportCsv } from "@/lib/report/daily-csv";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try { await requirePlatformReadAccess(); } catch { return NextResponse.json({ error: "forbidden" }, { status: 403 }); }
  const date = parseMetricDay(request.nextUrl.searchParams.get("date"));
  const version = Number(request.nextUrl.searchParams.get("version"));
  if (!date || !Number.isSafeInteger(version) || version < 1) return NextResponse.json({ error: "date and version required" }, { status: 400 });
  const view = await getOrgReport(date, new Date(), version);
  if (!view) return NextResponse.json({ error: "report version not found" }, { status: 404 });
  return new NextResponse(dailyReportCsv(view.doc, version), { headers: {
    "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="daily-report-${date}-v${version}.csv"`,
    "Cache-Control": "private, no-store",
  } });
}
