import { METRIC_COLLECTION_KIND, reconcileMetricCollectionInsights } from "@/lib/insights/metric-collection";
import { prisma } from "@/lib/prisma";
import { processNextInsight } from "@/lib/insights/service";
import {
  discoverOperationalSignals,
  publishWeeklySignals,
} from "@/lib/insights/triggers";
import { collectKeywordRanks } from "@/lib/market/keyword-collector";
import { collectCategoryRanks } from "@/lib/market/category-collector";
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
    console.log(await sendDailyKeywordRanks(new Date(), process.argv[3]));
    return;
  }
  if (mode === "category-ranks") {
    console.log(await collectCategoryRanks());
    return;
  }
  if (mode === "keywords") {
    let categoryResult: unknown = null;
    try { categoryResult = await collectCategoryRanks(); }
    catch { console.error("[operations-insights] 카테고리 순위 수집 실패"); }
    const keywordResult = await collectKeywordRanks();
    console.log({ keywordResult, categoryResult });
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
  const metricOnly = mode === "metric-collections";
  if (mode !== "worker" && !metricOnly) throw new Error("INVALID_MODE");
  let lastScan = 0;
  let lastReviewReportDay = "";
  while (!stopping) {
    try {
      if (Date.now() - lastScan >= 60_000) {
        if (!metricOnly && lastReviewReportDay !== metricDayOf(new Date())) {
          const result = await sendDailyReviewStatistics();
          if (result.status === "published") lastReviewReportDay = metricDayOf(new Date());
        }
        if (metricOnly) await reconcileMetricCollectionInsights();
        else await discoverOperationalSignals();
        lastScan = Date.now();
      }
      if (!(await processNextInsight(undefined, undefined, metricOnly ? METRIC_COLLECTION_KIND : undefined)))
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
  .catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code).replace(/[^A-Z0-9_]/g, "").slice(0, 64) : "COLLECTOR_FAILED";
    console.error("[operations-insights] 종료 실패", { code, name: error instanceof Error ? error.name : "UnknownError" });
    process.exitCode = 1;
  });
