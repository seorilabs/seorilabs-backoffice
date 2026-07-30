import { notFound } from "next/navigation";

import { ToolCatalog, WorkspaceSection } from "@/components/app-ops/WorkspaceUi";
import { toolsForSection } from "@/lib/app-ops/manifest";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { isoDate } from "@/lib/ga4/datasets";
import { prisma } from "@/lib/prisma";

export default async function AppAdsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const app = await prisma.app.findFirst({
    where: { id, ...visibleAppWhere },
    select: {
      id: true,
      repoFullName: true,
      opsManifest: true,
    },
  });
  if (!app) notFound();
  const [ga4, consoleMetric] = await Promise.all([
    prisma.appMetricDaily.findFirst({
      where: { appId: app.id },
      orderBy: { date: "desc" },
      select: { date: true, adEventUsers: true, adImpressions: true },
    }),
    prisma.appConsoleMetricDaily.findFirst({
      where: { appId: app.id },
      orderBy: { date: "desc" },
      select: {
        date: true,
        iaaImpressions: true,
        iaaEarningKrw: true,
      },
    }),
  ]);
  const tools = toolsForSection(app.opsManifest, "ads");

  return (
    <div className="space-y-8">
      <WorkspaceSection
        title="광고 현황"
        description="광고 노출 사용자, placement 운영과 채널별 수익 상태를 확인합니다."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <AdCard
            label="GA4 광고 이벤트 사용자"
            value={ga4?.adEventUsers}
            date={ga4?.date}
          />
          <AdCard label="GA4 광고 노출" value={ga4?.adImpressions} date={ga4?.date} />
          <AdCard
            label="AIT 광고 노출"
            value={consoleMetric?.iaaImpressions}
            date={consoleMetric?.date}
          />
          <AdCard
            label="AIT 광고 수익"
            value={
              consoleMetric
                ? `₩${Math.round(consoleMetric.iaaEarningKrw).toLocaleString("ko-KR")}`
                : undefined
            }
            date={consoleMetric?.date}
          />
        </div>
      </WorkspaceSection>

      <WorkspaceSection
        title="광고 오퍼레이션"
        description="placement 상태, 빈도 제한, 테스트 모드와 광고 보상 검증을 게임별로 선언합니다."
      >
        <ToolCatalog
          tools={tools}
          appId={app.id}
          repoFullName={app.repoFullName}
          emptyTitle="광고 오퍼레이션이 아직 없습니다"
          emptyDescription="광고가 있는 게임은 placement 조회, 빈도 제한, 테스트 광고 검증 도구를 manifest에 선언합니다."
        />
      </WorkspaceSection>
    </div>
  );
}

function AdCard({
  label,
  value,
  date,
}: {
  label: string;
  value?: string | number | null;
  date?: Date | null;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-neutral-900">{value ?? "—"}</div>
      <div className="mt-1 text-[11px] text-neutral-400">
        {date ? `기준일 ${isoDate(date)}` : "데이터 없음"}
      </div>
    </div>
  );
}
