import { createHash } from "node:crypto";
import { closedReviewGroups } from "./review-groups";
import { prisma } from "@/lib/prisma";
import { publishSignal } from "./service";
import { collectHighlightData } from "@/lib/core/metric-highlights";
import { sourceHealth } from "./queries";
import { decodePlayState } from "@/lib/google-play/release-state";
import {
  dbDay,
  metricDayOf,
  metricDayStart,
  lastElapsedMetricDay,
  shiftMetricDay,
  toDbDay,
} from "@/lib/analytics/metric-day";
import { env } from "@/lib/env";
import type { Evidence } from "./contract";
const base = () => env.optional("AUTH_URL") || "https://backoffice.vzyx.xyz";
export function submissionSignal(state: string, track: string | null) {
  const play = decodePlayState(state);
  if (["REJECTED", "METADATA_REJECTED"].includes(state) || play?.lifecycle === "NOT_APPROVED")
    return "submission-rejected";
  if (state === "READY_FOR_SALE" || state === "PENDING_APPLE_RELEASE") return null; // 승인·공개를 혼동하지 않는다.
  if (state === "READY_FOR_DISTRIBUTION") return "submission-approved";
  if (
    play?.lifecycle === "PUBLISHED" &&
    ["completed", "inProgress"].includes(play.status) &&
    track?.split(":").at(-1) === "production"
  )
    return "published";
  return null;
}
export async function discoverOperationalSignals(now = new Date()) {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const [reviewEvents, submissions, incidents, health, apps] = await Promise.all([
    prisma.notificationEvent.findMany({
      where: { kind: "STORE_REVIEW", createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { id: true, createdAt: true, payload: true },
    }),
    prisma.storeReviewSubmissionObservation.findMany({
      where: { lastObservedAt: { gte: since }, app: { status: "ACTIVE" } },
      include: { app: { select: { displayName: true } } },
      take: 500,
    }),
    prisma.operationalIncident.findMany({ where: { lastDetectedAt: { gte: since } }, take: 100 }),
    sourceHealth(),
    prisma.app.findMany({ where: { status: "ACTIVE" }, select: { id: true, displayName: true } }),
  ]);
  let count = 0;
  async function emit(input: Parameters<typeof publishSignal>[0]) {
    await publishSignal(input);
    count++;
  }
  // 최초 사실 알림은 기존 outbox가 즉시 보낸다. 완결된 15분 창에 변경 리뷰를 함께 분석한다.
  for (const [key, group] of closedReviewGroups(reviewEvents, now)) {
    const app = apps.find((app) => app.id === group.appId);
    if (!app) continue;
    await emit({
      dedupeKey: "reviews:" + key,
      appId: app.id,
      kind: "review-change",
      title: app.displayName + " 신규·변경 리뷰",
      observedAt: group.observedAt,
      facts: [
        {
          id: "reviews",
          label: "새로 관측한 리뷰 변화",
          value: group.count + "개 · 수정 " + group.updated + "개",
          source: group.store + " · 닫힌 15분 관측 창",
        },
        {
          id: "low_rating",
          label: "낮은 평점",
          value: group.lowRating + "개",
          source: "동일 관측 묶음 · 원문 분석 제외",
        },
      ],
      sourceRefs: [{ label: "리뷰 관측", url: base() + "/apps/" + app.id + "/feedback" }],
    });
  }
  const collected = await prisma.sourceCollectionRun.findMany({
    where: { completedAt: { gte: since }, status: { in: ["observed", "empty"] } },
    orderBy: { startedAt: "desc" },
    take: 500,
  });
  for (const row of collected) {
    const before = await prisma.sourceCollectionRun.findFirst({
      where: {
        source: row.source,
        target: row.target,
        appId: row.appId,
        startedAt: { lt: row.startedAt },
      },
      orderBy: { startedAt: "desc" },
    });
    if (!before || !["failed", "needs_input", "partial"].includes(before.status)) continue;
    await emit({
      dedupeKey: "source-recovery:" + row.id,
      appId: row.appId,
      kind: "source-recovery",
      title: "외부 자료 수집 회복",
      observedAt: row.completedAt!,
      facts: [
        {
          id: "source",
          label: row.source,
          value: "정상 응답 회복",
          source: row.target.slice(0, 200),
        },
      ],
      sourceRefs: [{ label: "수집 이력", url: base() + "/settings/health" }],
    });
  }
  for (const row of submissions) {
    const kind = submissionSignal(row.state, row.trackName);
    if (!kind) continue;
    await emit({
      dedupeKey: "submission:" + row.id + ":" + row.contentHash,
      appId: row.appId,
      kind,
      severity: kind === "submission-rejected" ? "critical" : "info",
      title: row.app.displayName + " · " + row.stateLabel,
      observedAt: row.sourceEventAt,
      facts: [
        {
          id: "state",
          label: row.store + " 관측 상태",
          value: row.stateLabel,
          source: "스토어 공식 API·webhook",
        },
      ],
      sourceRefs: [{ label: "출시 기록", url: base() + "/apps/" + row.appId + "/releases" }],
    });
  }
  for (const row of incidents)
    await emit({
      dedupeKey: "incident:" + row.id + ":" + row.status,
      appId: row.appId,
      kind: row.status === "RECOVERED" ? "service-recovery" : "service-failure",
      severity: row.status === "RECOVERED" ? "info" : "critical",
      title: "서비스 운영 상태 변경",
      observedAt: row.lastDetectedAt,
      facts: [
        { id: "state", label: row.source + " 상태", value: row.status, source: "운영 장애 원장" },
      ],
      sourceRefs: [{ label: "운영 기록", url: base() + "/work" }],
    });
  for (const row of health.rows.filter((row) =>
    ["failed", "stale", "needs_input"].includes(row.state),
  ))
    await emit({
      dedupeKey: "source:" + row.key + ":" + row.state + ":" + metricDayOf(now),
      appId: row.appId,
      kind: "source-stale",
      title: "수집 상태 확인 필요",
      observedAt: now,
      facts: [
        { id: "source", label: row.source, value: row.label, source: row.target.slice(0, 200) },
      ],
      sourceRefs: [{ label: "수집 상태", url: base() + "/settings/health" }],
    });
  const reports = await prisma.orgReportDaily.findMany({
    where: { date: { gte: toDbDay(shiftMetricDay(lastElapsedMetricDay(now), -2)) } },
    select: { report: true, date: true },
  });
  for (const report of reports) {
    const costs = (
      report.report as {
        costs?: { warnings?: Array<{ key: string; title: string; evidence: string[] }> };
      }
    ).costs;
    for (const warning of costs?.warnings ?? [])
      if (warning.evidence.length)
        await emit({
          dedupeKey:
            "cost:" +
            warning.key +
            ":" +
            dbDay(report.date) +
            ":" +
            createHash("sha256")
              .update(JSON.stringify(warning.evidence))
              .digest("hex")
              .slice(0, 24),
          kind: "cost-warning",
          severity: "critical",
          title: warning.title.slice(0, 180),
          observedAt: now,
          facts: warning.evidence.slice(0, 4).map((value, i) => ({
            id: "cost_" + i,
            label: "비용 관측",
            value: value.slice(0, 150),
            source: "재무 원장 " + dbDay(report.date),
          })),
          sourceRefs: [{ label: "비용 보고서", url: base() + "/?date=" + dbDay(report.date) }],
        });
  }
  const data = await collectHighlightData(now);
  for (const movement of data.movements
    .filter((row) => row.verdict === "highlight" || row.verdict === "lowlight")
    .slice(0, 20))
    await emit({
      dedupeKey: "metric:" + data.refDate + ":" + movement.label + ":" + movement.metricKey,
      appId:
        data.ga4Series.find((series) => series.app.displayName === movement.label)?.app.id ??
        data.consoleSeries.find((series) => series.label === movement.label)?.app.id,
      kind: "metric-change",
      title: movement.label + " 지표 변화",
      observedAt: now,
      facts: [
        {
          id: "metric",
          label: movement.metricKey,
          value: "최근 " + movement.latest + " · 기준선 " + movement.baseline,
          source: "지표 원본 " + data.refDate,
        },
      ],
      sourceRefs: [{ label: "종합 보고서", url: base() + "/?date=" + data.refDate }],
    });
  // 공개 확인 원장의 시점으로만 출시 후 +1/+3/+7 관측을 만든다.
  const published = await prisma.storeReviewSubmissionObservation.findMany({
    where: {
      sourceEventAt: { gte: new Date(now.getTime() - 10 * 86400000) },
      app: { status: "ACTIVE" },
    },
    take: 500,
  });
  for (const row of published.filter(
    (row) => submissionSignal(row.state, row.trackName) === "published",
  )) {
    const start = metricDayOf(row.sourceEventAt);
    for (const offset of [1, 3, 7]) {
      const day = shiftMetricDay(start, offset);
      if (day > lastElapsedMetricDay(now)) continue;
      const metrics = await prisma.appMetricDaily.findUnique({
        where: { appId_date: { appId: row.appId, date: toDbDay(day) } },
      });
      if (!metrics) continue;
      await emit({
        dedupeKey: "release-impact:" + row.id + ":" + offset,
        appId: row.appId,
        kind: "release-impact",
        title: "공개 확인 후 지표 관측",
        observedAt: now,
        facts: [
          {
            id: "impact",
            label: "공개 확인 후 관측",
            value: "+" + offset + "일 · " + dbDay(metrics.date) + " 활성 " + metrics.dau + "명",
            source: "GA4 · 출시 효과의 인과 증거 아님",
          },
        ],
        sourceRefs: [{ label: "앱 지표", url: base() + "/apps/" + row.appId + "/metrics" }],
      });
    }
  }
  const applePublic = await prisma.operationalSignal.findMany({
    where: {
      kind: "public-listing-confirmed",
      appId: { not: null },
      observedAt: { gte: new Date(now.getTime() - 10 * 86400000) },
    },
    take: 500,
  });
  for (const row of applePublic)
    for (const offset of [1, 3, 7]) {
      const day = shiftMetricDay(metricDayOf(row.observedAt), offset);
      if (day > lastElapsedMetricDay(now)) continue;
      const metric = await prisma.appMetricDaily.findUnique({
        where: { appId_date: { appId: row.appId!, date: toDbDay(day) } },
      });
      if (!metric) continue;
      await emit({
        dedupeKey: "apple-impact:" + row.id + ":" + offset,
        appId: row.appId,
        kind: "release-impact",
        title: "공개 리스팅 확인 후 지표 관측",
        observedAt: now,
        facts: [
          {
            id: "impact",
            label: "공개 관측 후",
            value: "+" + offset + "일 · 활성 " + metric.dau + "명",
            source: "공개 최초 관측 시각 기준 · 실제 출시일·인과 효과와 다름",
          },
        ],
        sourceRefs: [{ label: "공개 관측 근거", url: base() + "/feedback" }],
      });
    }
  return { count };
}
export async function publishWeeklySignals(now = new Date()) {
  const end = lastElapsedMetricDay(now),
    start = shiftMetricDay(end, -6);
  const data = await collectHighlightData(now, end);
  const days = await prisma.orgReportDaily.findMany({
    where: { date: { gte: toDbDay(start), lte: toDbDay(end) } },
    select: { date: true },
  });
  const reviews = await prisma.storeReviewObservation.count({
    where: {
      firstObservedAt: { gte: metricDayStart(start), lt: metricDayStart(shiftMetricDay(end, 1)) },
    },
  });
  const reviewSources = await prisma.sourceCollectionRun.findMany({
    where: {
      source: { startsWith: "reviews:" },
      status: { in: ["observed", "empty"] },
      completedAt: { gte: metricDayStart(start), lt: metricDayStart(shiftMetricDay(end, 1)) },
    },
    select: { appId: true },
  });
  const observedReviewApps = new Set(reviewSources.map((row) => row.appId)).size;
  const facts: Evidence[] = [
    { id: "period", label: "주간 범위", value: start + " ~ " + end, source: "KST 전주 월~일" },
    {
      id: "coverage",
      label: "일별 보고서",
      value:
        days.length +
        "/7일 · " +
        (days.length < 7 ? "부분 보고" : "모든 날짜 존재 · 앱별 수집 범위 별도"),
      source: "불변 보고서 원장",
    },
    {
      id: "reviews",
      label: "새로 관측한 리뷰",
      value: observedReviewApps
        ? reviews + "개 · 수집 성공 앱 " + observedReviewApps + "개"
        : "미수집",
      source: "수집 시각 기준 · 작성일과 다름",
    },
    {
      id: "active",
      label: "마지막 날 활성 합계",
      value: data.totals.ga4Dau.apps
        ? data.totals.ga4Dau.latest + "명 · " + data.totals.ga4Dau.apps + "개 앱 · 중복 포함"
        : "미수집",
      source: "GA4 " + end,
    },
  ];
  return publishSignal({
    dedupeKey: "weekly:" + end,
    kind: "metric-weekly",
    title: "주간 운영·성장 보고서",
    observedAt: now,
    facts,
    sourceRefs: [{ label: "기간 마지막 날 보고서", url: base() + "/?date=" + end }],
  });
}
