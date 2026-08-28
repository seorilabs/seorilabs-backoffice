import { PlatformAdsConsole } from "@/components/platform/PlatformAdsConsole";
import { requirePlatformReadAccess } from "@/lib/platform/access";
import { createPlatformReadClient } from "@/lib/platform/read-client";
import { resolvedPlatformAppId } from "@/lib/platform/app-id";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export default async function PlatformAdsPage() {
  await requirePlatformReadAccess();
  const candidates = await prisma.app.findMany({
    where: { status: "ACTIVE" },
    select: {
      slug: true,
      platformAppId: true,
      displayName: true,
      configSyncedAt: true,
    },
    orderBy: { displayName: "asc" },
  });
  const client = createPlatformReadClient();
  const checks = await Promise.allSettled(
    candidates.map((app) => client.adsConfig(resolvedPlatformAppId(app))),
  );
  const apps = candidates
    .filter((_, index) => checks[index]?.status === "fulfilled")
    .map((app) => ({
      appId: resolvedPlatformAppId(app),
      label: app.displayName,
      localConfigSyncedAt: app.configSyncedAt?.toISOString(),
    }));
  return <PlatformAdsConsole apps={apps} />;
}
