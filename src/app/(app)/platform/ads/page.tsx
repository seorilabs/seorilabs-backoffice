import { PlatformAdsConsole } from "@/components/platform/PlatformAdsConsole";
import { requirePlatformReadAccess } from "@/lib/platform/access";
import { createPlatformReadClient, platformReadConfiguration } from "@/lib/platform/read-client";
import { resolvedPlatformAppId } from "@/lib/platform/app-id";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export default async function PlatformAdsPage() {
  await requirePlatformReadAccess();
  const configuration = platformReadConfiguration();
  if (!configuration.configured) {
    return <section role="status" className="space-y-2">
      <h2 className="text-lg font-semibold">광고 관리</h2>
      <p className="text-sm text-neutral-600">{configuration.message}</p>
    </section>;
  }
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
