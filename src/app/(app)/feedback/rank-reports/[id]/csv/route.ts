import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { rankCsv } from "@/lib/market/daily-ranks";
import type { RankReport } from "@/lib/market/rank-report";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await auth())?.user) return new Response("인증 필요", { status: 401 });
  const { id } = await params;
  if (!/^\d{4}-\d{2}-\d{2}-[a-f0-9]{24}$/.test(id))
    return new Response("보고서 없음", { status: 404 });
  const event = await prisma.notificationEvent.findUnique({
    where: { dedupeKey: `keyword-report:${id}` },
  });
  const report = (event?.payload as { rankReport?: RankReport } | null)
    ?.rankReport;
  if (!report) return new Response("보고서 없음", { status: 404 });
  const csv = rankCsv(
    report.rows.map((r) => ({
      ...r,
      observedAt: r.observedAt ? new Date(r.observedAt) : null,
    })),
    report.day,
  );
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="search-ranks-${report.day}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
