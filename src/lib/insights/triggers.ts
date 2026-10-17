import { closedReviewGroups } from "./review-groups";
import { prisma } from "@/lib/prisma";
import { publishSignal } from "./service";
import { collectHighlightData } from "@/lib/core/metric-highlights";
import { decodePlayState } from "@/lib/google-play/release-state";
import {
  lastElapsedMetricDay,
  shiftMetricDay,
} from "@/lib/analytics/metric-day";
import { env } from "@/lib/env";
import type { Evidence } from "./contract";
const base = () => env.optional("AUTH_URL") || "https://backoffice.vzyx.xyz";
export function submissionSignal(state: string, track: string | null) {
  const play = decodePlayState(state);
  if (
    ["REJECTED", "METADATA_REJECTED"].includes(state) ||
    play?.lifecycle === "NOT_APPROVED"
  )
    return "submission-rejected";
  if (state === "READY_FOR_SALE" || state === "PENDING_APPLE_RELEASE")
    return null; // 승인·공개를 혼동하지 않는다.
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
  const [reviewEvents, apps] = await Promise.all([
    prisma.notificationEvent.findMany({
      where: { kind: "STORE_REVIEW", createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { id: true, createdAt: true, payload: true },
    }),
    prisma.app.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, displayName: true },
    }),
  ]);
  let count = 0;
  async function emit(input: Parameters<typeof publishSignal>[0]) {
    await publishSignal(input);
    count++;
  }
  for (const [key, group] of closedReviewGroups(reviewEvents, now)) {
    const app = apps.find((app) => app.id === group.appId);
    if (!app || !group.reviews.length) continue;
    await emit({
      dedupeKey: "review-themes:" + key,
      appId: app.id,
      kind: "review-themes",
      title: `${app.displayName} · 사용자 리뷰의 불편·요청·칭찬`,
      observedAt: group.observedAt,
      facts: group.reviews.slice(0, 12).map((review, i) => ({
        id: `review_${i}`,
        label: `${review.rating}점 리뷰`.slice(0, 100),
        value: review.body.slice(0, 160),
        source: `${group.store} · ${group.locale} · 버전 ${group.version} · ${review.change === "updated" ? "수정 리뷰" : "새 리뷰"}`,
      })),
      sourceRefs: [
        {
          label: "리뷰 원문과 근거",
          url: base() + "/apps/" + app.id + "/feedback",
        },
      ],
    });
  }
  return { count };
}
export async function publishWeeklySignals(now = new Date()) {
  const end = lastElapsedMetricDay(now),
    start = shiftMetricDay(end, -6);
  const data = await collectHighlightData(now, end);
  const facts: Evidence[] = data.movements
    .filter((m) => m.verdict === "highlight" || m.verdict === "lowlight")
    .slice(0, 8)
    .map((m, i) => ({
      id: `change_${i}`,
      label: `${m.label} ${m.spec.ko}`.slice(0, 100),
      value: `${m.spec.format(m.latest)} · 기준 ${m.baseline === null ? "비교 불가" : m.spec.format(m.baseline)}`,
      source: `${end} 일별 값 · 직전 7일 중앙값 대비 · ${m.spec.source}`,
    }));
  if (!facts.length)
    return { suppressed: true, reason: "NO_MATERIAL_WEEKLY_CHANGE" };
  return publishSignal({
    dedupeKey: "weekly:" + end,
    kind: "metric-weekly",
    title: `주간 점검 · ${start} ~ ${end} · 마지막 날의 주요 변화`,
    observedAt: now,
    facts,
    sourceRefs: [
      { label: "기간 마지막 날 보고서", url: base() + "/?date=" + end },
    ],
  });
}
