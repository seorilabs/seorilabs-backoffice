import { prisma } from "@/lib/prisma";
import { processNextInsight } from "@/lib/insights/service";
import {
  discoverOperationalSignals,
  publishWeeklySignals,
} from "@/lib/insights/triggers";
import { collectMarketFeedback } from "@/lib/market/collector";
import { collectAndroidVitals } from "@/lib/market/android-vitals";
import { sendDailyKeywordRanks } from "@/lib/market/daily-ranks";
import { sendDailyReviewStatistics } from "@/lib/store-reviews/daily-statistics";
import { metricDayOf } from "@/lib/analytics/metric-day";
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function main() {
  const mode = process.argv[2] ?? "worker";
  if (mode === "review-daily") {
    if (process.argv.length !== 5) throw new Error("INVALID_REPORT_ARGUMENTS");
    console.log(await sendDailyReviewStatistics(new Date(), {day:process.argv[3],appSlug:process.argv[4]}));
    return;
  }
  if (mode === "keyword-daily") {
    if (process.argv.length > 4) throw Error("INVALID_REPORT_ARGUMENTS");
    await sendDailyKeywordRanks(new Date(), process.argv[3]);
    return;
  }
  if (mode === "market") {
    await collectMarketFeedback();
    await collectAndroidVitals();
    return;
  }
  if (mode === "weekly") {
    await publishWeeklySignals();
    return;
  }
  if (mode !== "worker") throw new Error("INVALID_MODE");
  let lastScan = 0;
  let lastReviewReportDay = "";
  while (!stopping) {
    try {
      if (Date.now() - lastScan >= 60_000) {
        if (lastReviewReportDay !== metricDayOf(new Date())) {
          const result = await sendDailyReviewStatistics();
          if (result.status === "published") lastReviewReportDay = metricDayOf(new Date());
        }
        await discoverOperationalSignals();
        lastScan = Date.now();
      }
      if (!(await processNextInsight()))
        await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch {
      console.error(
        "[operations-insights] 작업 실패 · 원장과 수집 상태 확인 필요",
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
main()
  .finally(() => prisma.$disconnect())
  .catch(() => {
    console.error("[operations-insights] 종료 실패");
    process.exitCode = 1;
  });
