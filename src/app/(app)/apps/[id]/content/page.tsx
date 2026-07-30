import { notFound } from "next/navigation";

import {
  ContentMarketTabs,
  ContentSection,
} from "@/components/analytics/AppContentPanels";
import {
  EmptyState,
  ToolCatalog,
  WorkspaceSection,
} from "@/components/app-ops/WorkspaceUi";
import type { ContentMetricSnapshot } from "@/lib/analytics/content-source";
import { parseMarket } from "@/lib/analytics/market";
import { resolveAppContentSpec } from "@/lib/app-ops/content-spec";
import { toolsForSection } from "@/lib/app-ops/manifest";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { isoDate } from "@/lib/ga4/datasets";
import { prisma } from "@/lib/prisma";

export default async function AppContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ market?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const app = await prisma.app.findFirst({
    where: { id, ...visibleAppWhere },
    select: {
      id: true,
      slug: true,
      repoFullName: true,
      opsManifest: true,
    },
  });
  if (!app) notFound();
  const spec = resolveAppContentSpec(app.slug, app.opsManifest);
  const tools = toolsForSection(app.opsManifest, "content");
  const market = spec ? parseMarket(spec, sp.market) : "all";
  const row = spec
    ? await prisma.appContentMetricDaily.findFirst({
        where: { appId: app.id, market },
        orderBy: { date: "desc" },
      })
    : null;

  return (
    <div className="space-y-8">
      <WorkspaceSection
        title="콘텐츠 통계"
        description="게임이 선언한 이벤트 스펙으로 레벨, 경제, 퍼널과 콘텐츠별 성과를 조회합니다."
      >
        {spec ? (
          <>
            <ContentMarketTabs
              spec={spec}
              appSlug={app.slug}
              selected={market}
              hrefBase={`/apps/${app.id}/content`}
            />
            {row ? (
              <div className="space-y-3">
                <div className="text-right text-xs text-neutral-400">
                  기준일 {isoDate(row.date)}
                </div>
                <ContentSection
                  spec={spec}
                  snapshot={row.raw as unknown as ContentMetricSnapshot}
                />
              </div>
            ) : (
              <EmptyState title="수집된 콘텐츠 지표가 없습니다">
                다음 콘텐츠 지표 수집 후 표시됩니다.
              </EmptyState>
            )}
          </>
        ) : (
          <EmptyState title="콘텐츠 지표 스펙이 없습니다">
            게임 저장소의 manifest에 analytics.content를 선언하면 수집 대상에 자동 편입됩니다.
          </EmptyState>
        )}
      </WorkspaceSection>

      <WorkspaceSection
        title="콘텐츠 오퍼레이션"
        description="콘텐츠 발행, 재집계, 보상 테이블 검증 등 게임별 운영 작업입니다."
      >
        <ToolCatalog
          tools={tools}
          appId={app.id}
          repoFullName={app.repoFullName}
          emptyTitle="콘텐츠 오퍼레이션이 아직 없습니다"
          emptyDescription="게임 저장소 manifest에서 content 섹션 도구를 선언하세요."
        />
      </WorkspaceSection>
    </div>
  );
}
