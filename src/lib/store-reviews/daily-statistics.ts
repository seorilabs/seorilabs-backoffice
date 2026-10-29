import { z } from "zod";
import { env } from "@/lib/env";
import { lastElapsedMetricDay, metricDayOf, metricDayStart, parseMetricDay, metricDaysBetween } from "@/lib/analytics/metric-day";
import { notificationDestinations } from "@/lib/notifications/destinations";
import { enqueueEditableNotification } from "@/lib/notifications/outbox";
import { prisma } from "@/lib/prisma";
import { storeLabel } from "./shape";

const payloadSchema = z.object({
  appId: z.string(), store: z.enum(["APP_STORE", "GOOGLE_PLAY"]),
  externalReviewId: z.string(), rating: z.number().int().min(1).max(5), change: z.enum(["new", "updated"]),
});
export interface ReviewStatisticEvent { id: string; createdAt: Date; payload: unknown }
export interface DailyReviewStatistic {
  appId: string; store: "APP_STORE" | "GOOGLE_PLAY"; count: number;
  newCount: number; updatedCount: number; average: number; ratings: number[];
}
/** 같은 리뷰의 마지막 별점만 집계하고 본문은 통계에 넘기지 않는다. */
export function reviewStatistics(events: ReviewStatisticEvent[]): DailyReviewStatistic[] {
  const latest = new Map<string, { value: z.infer<typeof payloadSchema>; at: number; id: string; isNew: boolean }>();
  for (const event of events) {
    const result = payloadSchema.safeParse(event.payload);
    if (!result.success) continue;
    const row = result.data;
    const key = JSON.stringify([row.appId, row.store, row.externalReviewId]);
    const prior = latest.get(key);
    const isNew = row.change === "new" || prior?.isNew === true;
    if (!prior || event.createdAt.getTime() > prior.at ||
      (event.createdAt.getTime() === prior.at && event.id > prior.id))
      latest.set(key, { value: row, at: event.createdAt.getTime(), id: event.id, isNew });
    else prior.isNew = isNew;
  }
  const groups = new Map<string, DailyReviewStatistic>();
  for (const { value: row, isNew } of latest.values()) {
    const key = JSON.stringify([row.appId, row.store]);
    const group = groups.get(key) ?? { appId: row.appId, store: row.store, count: 0, newCount: 0, updatedCount: 0, average: 0, ratings: [0,0,0,0,0] };
    group.count++; group[isNew ? "newCount" : "updatedCount"]++;
    group.ratings[row.rating - 1]++;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, average: group.ratings.reduce((sum, n, index) => sum + n * (index + 1), 0) / group.count }))
    .sort((a,b) => a.appId.localeCompare(b.appId) || a.store.localeCompare(b.store));
}

export function reviewStatisticsText(row: DailyReviewStatistic, appName: string, day: string): string {
  const name = appName.replace(/[@<>\r\n]/g, "").replace(/([\\`*_~|\[\]])/g, "\\$1");
  const max = Math.max(...row.ratings, 1);
  const stars = [...row.ratings].reverse().map((n, i) => `${5-i}★ ${n ? "▰".repeat(Math.max(1, Math.round(n/max*10))) : "—"} ${n}`);
  return `**${name} · ${storeLabel(row.store)} 리뷰 통계**\n${day} KST 수집 기준\n리뷰 **${row.count}개** · 새 리뷰 ${row.newCount} · 수정 리뷰 ${row.updatedCount}\n평균 **${row.average.toFixed(2)}/5**\n${stars.join("\n")}\n같은 리뷰는 마지막 별점으로 한 번 집계합니다. 스토어 전체 누적 평점과는 다릅니다.`;
}

export interface ReviewStatisticsDependencies {
  listEvents(start: Date, end: Date): Promise<ReviewStatisticEvent[]>;
  listApps(): Promise<Array<{id:string; slug:string; displayName:string}>>;
  enqueue: typeof enqueueEditableNotification;
}
const defaults: ReviewStatisticsDependencies = {
  listEvents: (start,end) => prisma.notificationEvent.findMany({where:{kind:"STORE_REVIEW",createdAt:{gte:start,lt:end}},select:{id:true,createdAt:true,payload:true},orderBy:[{createdAt:"asc"},{id:"asc"}]}),
  listApps: () => prisma.app.findMany({where:{status:"ACTIVE"},select:{id:true,slug:true,displayName:true}}),
  enqueue: enqueueEditableNotification,
};
/** 자동 발행은 11시 이후, 명시한 날짜와 앱의 수동 발행도 같은 키를 쓴다. */
export async function sendDailyReviewStatistics(
  now = new Date(),
  manual?: { day: string; appSlug: string },
  dependencies: ReviewStatisticsDependencies = defaults,
) {
  const kstHour = new Date(now.getTime()+9*3600000).getUTCHours();
  if (!manual && kstHour < 11) return { status: "not-due", reports: 0 };
  const day = manual?.day ?? lastElapsedMetricDay(now);
  if (!parseMetricDay(day) || day >= metricDayOf(now) || metricDaysBetween(metricDayOf(now),day) > env.reviewRetentionDays()) throw new Error("INVALID_REVIEW_REPORT_DAY");
  const apps = await dependencies.listApps();
  if (manual && !apps.some(app=>app.slug===manual.appSlug)) throw new Error("REVIEW_REPORT_APP_NOT_FOUND");
  const start = metricDayStart(day), end = new Date(start.getTime()+86400000);
  const events = await dependencies.listEvents(start,end);
  let reports = 0;
  for (const group of reviewStatistics(events)) {
    const app = apps.find(app=>app.id===group.appId && (!manual || app.slug===manual.appSlug));
    if (!app) continue;
    await dependencies.enqueue({
      dedupeKey: `review-statistics:${app.id}:${group.store}:${day}`, kind: "OPERATIONS_SUMMARY", occurredAt: end,
      payload: { text: reviewStatisticsText(group,app.displayName,day), appId: app.id, store: group.store, day,
        report: {category:"change",reason:"DAILY_REVIEW_STATISTICS"},
        embed: {title:"리뷰 일간 통계",color:0x2563eb} },
      destinations: notificationDestinations(["user-reviews"]),
    });
    reports++;
  }
  return { status: "published", day, reports };
}
