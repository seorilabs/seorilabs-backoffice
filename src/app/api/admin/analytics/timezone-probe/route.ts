import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyStaticToken } from "@/lib/security";
import { resolveGa4Target } from "@/lib/ga4/datasets";
import { queryEventDateBoundaries } from "@/lib/ga4/bigquery";
import { inferPropertyOffsetHours } from "@/lib/ga4/property-timezone";
import {
  lastElapsedMetricDay,
  metricDayWindow,
  toGa4TableSuffix,
} from "@/lib/analytics/metric-day";

// GA4 property 보고 타임존 확인. 백오피스는 모든 일별 지표를 METRIC_DAY_TZ(Asia/Seoul)
// 달력일 하나로 합산하는데, export 의 event_date 는 property 타임존의 달력일이라
// 축이 다른 property 가 섞이면 합계가 틀린다. 그 전제를 추정하지 않고 실측한다.
//
// 상시 필요하다. 새 앱을 붙일 때마다 그 property 가 같은 축인지 확인해야 하고,
// 콘솔에서 타임존을 바꾸면 조용히 어긋난다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PROBE_DAYS = 3;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    // 마지막 달력일은 export 가 아직 안 왔을 수 있어 하루 더 물린다.
    const end = lastElapsedMetricDay(new Date());
    const window = metricDayWindow(end, PROBE_DAYS + 1);
    const startSuffix = toGa4TableSuffix(window[0]);
    const endSuffix = toGa4TableSuffix(window[window.length - 1]);

    const apps = await prisma.app.findMany({
      orderBy: { slug: "asc" },
      select: { slug: true, firebaseProject: true, ga4Dataset: true },
    });

    const results: unknown[] = [];
    const skipped: string[] = [];
    for (const app of apps) {
      const target = resolveGa4Target(app);
      if (!target) {
        skipped.push(app.slug);
        continue;
      }
      try {
        const rows = await queryEventDateBoundaries(target, startSuffix, endSuffix);
        results.push({ slug: app.slug, inference: inferPropertyOffsetHours(rows) });
      } catch (e) {
        results.push({ slug: app.slug, error: (e as Error).message.slice(0, 300) });
      }
    }
    return NextResponse.json({ ok: true, window: { startSuffix, endSuffix }, results, skipped });
  } catch (e) {
    console.error("[admin/analytics/timezone-probe] 실패:", e);
    return NextResponse.json({ error: "timezone probe failed" }, { status: 500 });
  }
}
