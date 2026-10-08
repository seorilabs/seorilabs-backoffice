import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { orgTrendSeries } from "@/lib/core/org-report";
import {
  dbDay,
  shiftMetricDay,
  toDbDay,
  metricDayOf,
  metricDayStart,
} from "@/lib/analytics/metric-day";
import { reportChartSvg } from "./discord-chart";
import type { DiscordAttachment } from "@/lib/notifications/discord";
export async function operationsChart(end: string, weekly = false): Promise<DiscordAttachment> {
  const points = await orgTrendSeries(end, weekly ? 7 : 28);
  const days = points.map((point) => point.date);
  const charts: Array<Parameters<typeof reportChartSvg>[0]> = [
    {
      title: "활성·신규 사용자 · " + end,
      days,
      unit: "명",
      source: "GA4 · 앱 간 사용자 중복 포함 · 미수집 구간 제외",
      series: [
        { label: "활성 합계", color: "#2563eb", values: points.map((p) => p.ga4Dau) },
        { label: "신규 합계", color: "#059669", values: points.map((p) => p.ga4NewUsers) },
      ],
    },
    {
      title: "광고 추정 수익·결제 거래액",
      days,
      unit: "KRW",
      source: "앱인토스 콘솔 · 광고 추정 수익과 거래액 · 정산·환불 후 순수익과 다름",
      series: [
        { label: "광고 추정 수익", color: "#d97706", values: points.map((p) => p.consoleIaaKrw) },
        { label: "결제 거래액", color: "#7c3aed", values: points.map((p) => p.consoleIapTrxKrw) },
      ],
    },
  ];
  if (weekly) {
    const start = toDbDay(shiftMetricDay(end, -6)),
      limit = toDbDay(shiftMetricDay(end, 1));
    const [metrics, ranks, reviews, sources] = await Promise.all([
      prisma.appMetricDaily.findMany({
        where: {
          date: { gte: start, lt: limit },
          cohortUsers: { not: null },
          d1Users: { not: null },
          app: { status: "ACTIVE" },
        },
        select: { date: true, cohortUsers: true, d1Users: true },
      }),
      prisma.marketObservation.findMany({
        where: { day: { gte: start, lt: limit }, kind: "keyword" },
        take: 1000,
        orderBy: { day: "desc" },
      }),
      prisma.storeReviewObservation.findMany({
        where: {
          firstObservedAt: {
            gte: metricDayStart(days[0]),
            lt: metricDayStart(shiftMetricDay(end, 1)),
          },
        },
        select: { firstObservedAt: true },
      }),
      prisma.sourceCollectionRun.findMany({
        where: {
          source: { startsWith: "reviews:" },
          status: { in: ["observed", "empty"] },
          completedAt: { gte: metricDayStart(days[0]), lt: metricDayStart(shiftMetricDay(end, 1)) },
        },
        select: { completedAt: true },
      }),
    ]);
    const denominators = days
      .map((day) =>
        metrics
          .filter((row) => dbDay(row.date) === day)
          .reduce((sum, row) => sum + row.cohortUsers!, 0),
      )
      .filter((n) => n > 0);
    charts.push({
      title: "관측 코호트 D1 · 실제 신규 인원으로 가중",
      days,
      unit: "%",
      scope: denominators.length
        ? `관측일별 코호트 분모 ${Math.min(...denominators)}~${Math.max(...denominators)}명`
        : "성숙 코호트 분모 미수집",
      source: "GA4 · 성숙·관측된 코호트만 · 앱별 누락 가능 · 기준일은 최초 유입일",
      series: [
        {
          label: "다음 날 복귀율",
          color: "#2563eb",
          values: days.map((day) => {
            const rows = metrics.filter((row) => dbDay(row.date) === day),
              n = rows.reduce((sum, row) => sum + row.cohortUsers!, 0);
            return n ? (rows.reduce((sum, row) => sum + row.d1Users!, 0) / n) * 100 : null;
          }),
        },
      ],
    });
    const targets = [
      ...new Set(ranks.map((row) => row.appId + ":" + row.country + ":" + row.target)),
    ].slice(0, 4);
    if (targets.length)
      charts.push({
        title: "검색 노출 관측 · 최대 네 검색어",
        days,
        unit: "관측 순서",
        reverse: true,
        source: "Apple 공개 API · 상위 200개 · 권외·미수집은 빈 구간 · 기기 순위와 다름",
        series: targets.map((key, i) => {
          const own = ranks.filter(
            (row) => row.appId + ":" + row.country + ":" + row.target === key,
          );
          return {
            label: own[0].country.toUpperCase() + " " + own[0].target.slice(0, 14),
            color: ["#2563eb", "#059669", "#d97706", "#7c3aed"][i],
            values: days.map((day) => {
              const value = own.find((row) => dbDay(row.day) === day)?.value as
                { rank?: number | null } | undefined;
              return value?.rank ?? null;
            }),
          };
        }),
      });
    charts.push({
      title: "새로 관측한 리뷰 · 작성일과 다름",
      days,
      unit: "개",
      source: "스토어 리뷰 수집 원장 · 전체 스토어 평점과 다름 · 성공 수집 없는 날은 미수집",
      series: [
        {
          label: "새 리뷰 관측",
          color: "#059669",
          values: days.map((day) =>
            sources.some((row) => row.completedAt && metricDayOf(row.completedAt) === day)
              ? reviews.filter((row) => metricDayOf(row.firstObservedAt) === day).length
              : null,
          ),
        },
      ],
    });
  }
  const buffers = await Promise.all(
    charts.map((chart) =>
      sharp(Buffer.from(reportChartSvg(chart)))
        .png()
        .toBuffer(),
    ),
  );
  const bytes = await sharp({
    create: { width: 960, height: charts.length * 510, channels: 4, background: "#ffffff" },
  })
    .composite(buffers.map((input, index) => ({ input, left: 0, top: index * 510 })))
    .png()
    .toBuffer();
  return {
    filename: weekly ? "weekly-operations.png" : "daily-operations.png",
    contentType: "image/png",
    base64: bytes.toString("base64"),
  };
}
