import { PlatformVersionDistributionView } from "@/components/platform/PlatformVersionDistribution";
import { requirePlatformReadAccess } from "@/lib/platform/access";
import { assertPresencePipelineReady } from "@/lib/platform/presence-pipeline";
import {
  loadPlatformVersionDistributions,
  type PlatformVersionDistribution,
} from "@/lib/platform/version-distribution";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function PlatformUpdatesPage() {
  await requirePlatformReadAccess();
  const apps = await prisma.app.findMany({
    where: { status: "ACTIVE" },
    select: { slug: true, platformAppId: true, displayName: true },
    orderBy: { displayName: "asc" },
  });

  let distributions: PlatformVersionDistribution[] = [];
  let error: string | null = null;
  try {
    // 집계를 읽기 전에 파이프라인을 확인한다. Edge가 죽은 동안 읽으면
    // 만료된 행 때문에 "구버전 유저가 사라졌다"로 보인다.
    await assertPresencePipelineReady();
    distributions = await loadPlatformVersionDistributions(apps);
  } catch (caught) {
    error =
      caught instanceof Error
        ? caught.message
        : "버전 분포를 읽지 못했습니다.";
  }

  return (
    <PlatformVersionDistributionView
      state={error ? "unavailable" : "available"}
      distributions={distributions}
      error={error}
    />
  );
}
