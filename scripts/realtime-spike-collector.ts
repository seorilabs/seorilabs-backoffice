import { prisma } from "@/lib/prisma";
import { loadGa4RealtimeSnapshot } from "@/lib/ga4/realtime";
import { purgeRealtimeActivitySamples, recordRealtimeActivity } from "@/lib/ga4/realtime-spike";

async function main(): Promise<void> {
  const bucketAt = new Date(Math.floor(Date.now() / 300_000) * 300_000);
  const snapshot = await loadGa4RealtimeSnapshot(bucketAt);
  const apps = await prisma.app.findMany({
    where: { slug: { in: snapshot.apps.map((app) => app.slug) } },
    select: { id: true, slug: true },
  });
  const ids = new Map(apps.map((app) => [app.slug, app.id]));
  let sampled = 0;
  let alerted = 0;
  let failed = 0;
  for (const app of snapshot.apps) {
    const appId = ids.get(app.slug);
    if (!app.ok || !appId) {
      failed++;
      console.error("[realtime-spike] 앱 조회 실패", app.slug, app.ok ? "앱 매핑 없음" : app.error);
      continue;
    }
    try {
      const result = await recordRealtimeActivity({
        appId, displayName: app.displayName,
        activeUsers: app.recentActiveUsers, bucketAt,
      });
      if (result === "alerted") alerted++;
      if (result !== "duplicate") sampled++;
    } catch (error) {
      failed++;
      console.error("[realtime-spike] 기록 실패", app.slug,
        error instanceof Error ? error.message.slice(0, 200) : "unknown");
    }
  }
  await purgeRealtimeActivitySamples(bucketAt);
  console.log("[realtime-spike] result", JSON.stringify({ targets: snapshot.apps.length, sampled, alerted, failed }));
  if (snapshot.apps.length > 0 && failed === snapshot.apps.length) {
    throw new Error("GA4 실시간 대상 전체 실패");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("[realtime-spike] 실패", error instanceof Error ? error.message.slice(0, 200) : "unknown");
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
  });
