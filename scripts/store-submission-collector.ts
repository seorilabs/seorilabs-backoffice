import { prisma } from "@/lib/prisma";
import { listGooglePlayTrackReleases } from "@/lib/google-play/tracks-fetcher";
import { applyGooglePlayTrackRelease } from "@/lib/google-play/tracks-collector";
import type { GoogleServiceAccountClaims } from "@/lib/google-play/service-account";

async function main(): Promise<void> {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Google Play Publisher 자격증명 없음");
  const claims = JSON.parse(raw) as GoogleServiceAccountClaims;
  if (!claims.client_email || !claims.private_key) throw new Error("Google Play Publisher 자격증명 형식 오류");
  const apps = await prisma.app.findMany({
    where: { playPackage: { not: null } },
    select: { id: true, displayName: true, playPackage: true, marketTargets: true },
  });
  let targets = 0;
  let succeeded = 0;
  let failed = 0;
  for (const app of apps) {
    if (!app.playPackage || !Array.isArray(app.marketTargets) ||
        !app.marketTargets.includes("play")) continue;
    targets++;
    try {
      const releases = await listGooglePlayTrackReleases({
        packageName: app.playPackage, claims,
      });
      const now = new Date();
      for (const release of releases) {
        await applyGooglePlayTrackRelease({
          appId: app.id,
          appDisplayName: app.displayName ?? app.id,
          packageName: app.playPackage,
          release,
          sourceEventAt: now,
        });
      }
      await prisma.storeReviewSubmissionSync.upsert({
        where: { appId_store: { appId: app.id, store: "GOOGLE_PLAY" } },
        create: { appId: app.id, store: "GOOGLE_PLAY", lastSuccessAt: now },
        update: { lastSuccessAt: now, lastFailureReason: null },
      });
      succeeded++;
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message.slice(0, 200) : "unknown";
      console.error("[play-tracks] 앱 조회 실패", app.id, message);
      await prisma.storeReviewSubmissionSync.upsert({
        where: { appId_store: { appId: app.id, store: "GOOGLE_PLAY" } },
        create: { appId: app.id, store: "GOOGLE_PLAY", lastFailureAt: new Date(), lastFailureReason: message },
        update: { lastFailureAt: new Date(), lastFailureReason: message },
      });
    }
  }
  console.log("[play-tracks] result", JSON.stringify({ targets, succeeded, failed }));
  if (targets > 0 && succeeded === 0) throw new Error("Google Play 대상 전체 실패");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("[play-tracks] 실패", error instanceof Error ? error.message : "unknown");
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
  });
