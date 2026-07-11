import { prisma } from "@/lib/prisma";
import { isoDate } from "@/lib/ga4/datasets";
import {
  CropMetricTable,
  AreaFunnelTable,
  AdPlacementTable,
  FeatureFunnelPanels,
} from "@/components/analytics/ContentMetricPanels";

// happy-farm 콘텐츠 세부 지표 섹션(서버 컴포넌트). happy_farm_* 스냅샷의 최신 기준일
// rows 를 테이블별로 읽어 콘텐츠 패널로 렌더한다. 각 테이블의 최신 기준일을 독립적으로
// 잡아, 일부 차원이 비어도 나머지가 표시되도록 한다.

async function latestDate(
  find: (args: { where: { appId: string }; orderBy: { date: "desc" }; select: { date: true } }) => Promise<{ date: Date } | null>,
  appId: string,
): Promise<Date | null> {
  const r = await find({ where: { appId }, orderBy: { date: "desc" }, select: { date: true } });
  return r?.date ?? null;
}

export async function ContentMetricsSection({ appId }: { appId: string }) {
  const [cropDate, areaDate, funnelDate, adDate] = await Promise.all([
    latestDate((a) => prisma.happyFarmCropDaily.findFirst(a), appId),
    latestDate((a) => prisma.happyFarmAreaDaily.findFirst(a), appId),
    latestDate((a) => prisma.happyFarmFunnelDaily.findFirst(a), appId),
    latestDate((a) => prisma.happyFarmAdPlacementDaily.findFirst(a), appId),
  ]);

  const [crops, areas, funnels, adPlacements] = await Promise.all([
    cropDate
      ? prisma.happyFarmCropDaily.findMany({
          where: { appId, date: cropDate },
          orderBy: { revenue: "desc" },
        })
      : Promise.resolve([]),
    areaDate
      ? prisma.happyFarmAreaDaily.findMany({
          where: { appId, date: areaDate },
          orderBy: { unlockClicked: "desc" },
        })
      : Promise.resolve([]),
    funnelDate
      ? prisma.happyFarmFunnelDaily.findMany({ where: { appId, date: funnelDate } })
      : Promise.resolve([]),
    adDate
      ? prisma.happyFarmAdPlacementDaily.findMany({
          where: { appId, date: adDate },
          orderBy: { impressions: "desc" },
        })
      : Promise.resolve([]),
  ]);

  const hasAny =
    crops.length > 0 || areas.length > 0 || funnels.length > 0 || adPlacements.length > 0;

  if (!hasAny) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
        아직 수집된 콘텐츠 지표가 없습니다. (매일 수집 후 표시됩니다)
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-semibold text-neutral-700">작물 지표</span>
          {cropDate && <span className="text-xs text-neutral-400">기준일 {isoDate(cropDate)}</span>}
        </div>
        <CropMetricTable rows={crops} />
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-semibold text-neutral-700">구역 언락 퍼널</span>
          {areaDate && <span className="text-xs text-neutral-400">기준일 {isoDate(areaDate)}</span>}
        </div>
        <AreaFunnelTable rows={areas} />
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-semibold text-neutral-700">기능 퍼널</span>
          {funnelDate && (
            <span className="text-xs text-neutral-400">기준일 {isoDate(funnelDate)}</span>
          )}
        </div>
        <FeatureFunnelPanels rows={funnels} />
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-semibold text-neutral-700">광고 placement 퍼널</span>
          {adDate && <span className="text-xs text-neutral-400">기준일 {isoDate(adDate)}</span>}
        </div>
        <AdPlacementTable rows={adPlacements} />
      </div>
    </div>
  );
}
