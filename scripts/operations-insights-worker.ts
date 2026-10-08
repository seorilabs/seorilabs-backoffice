import { prisma } from "@/lib/prisma";
import { processNextInsight } from "@/lib/insights/service";
import { discoverOperationalSignals, publishWeeklySignals } from "@/lib/insights/triggers";
import { collectMarketFeedback } from "@/lib/market/collector";
import { collectAndroidVitals } from "@/lib/market/android-vitals";
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function main() {
  const mode = process.argv[2] ?? "worker";
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
  while (!stopping) {
    try {
      if (Date.now() - lastScan >= 60_000) {
        await discoverOperationalSignals();
        lastScan = Date.now();
      }
      if (!(await processNextInsight())) await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch {
      console.error("[operations-insights] 작업 실패 · 원장과 수집 상태 확인 필요");
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
