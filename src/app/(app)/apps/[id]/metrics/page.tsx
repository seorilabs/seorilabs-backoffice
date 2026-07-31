import { notFound } from "next/navigation";

import { ConsoleSection, type ConsoleMetricDaily } from "@/components/analytics/ConsolePanels";
import {
  DauTrend,
  MetricCards,
  MetricTrendTable,
  PlatformSplit,
  TopDimList,
  type MetricDaily,
} from "@/components/analytics/MetricPanels";
import { EmptyState, Panel, WorkspaceSection } from "@/components/app-ops/WorkspaceUi";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { isoDate, resolveGa4Target } from "@/lib/ga4/datasets";
import { resolveAitTarget, listingsForSlug } from "@/lib/analytics/ait-apps";
import { prisma } from "@/lib/prisma";

const WINDOW = 28;

export default async function AppMetricsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const app = await prisma.app.findFirst({
    where: { id, ...visibleAppWhere },
    select: {
      id: true,
      slug: true,
      displayName: true,
      firebaseProject: true,
      ga4Dataset: true,
      aitWorkspaceId: true,
      aitMiniAppId: true,
    },
  });
  if (!app) notFound();

  const [ga4Rows, consoleRows] = await Promise.all([
    resolveGa4Target(app)
      ? (prisma.appMetricDaily.findMany({
          where: { appId: app.id },
          orderBy: { date: "desc" },
          take: WINDOW,
        }) as unknown as Promise<MetricDaily[]>)
      : Promise.resolve([]),
    resolveAitTarget(app)
      ? (prisma.appConsoleMetricDaily.findMany({
          where: { appId: app.id },
          orderBy: { date: "desc" },
          // 리스팅별로 나눠 보이므로 리스팅 수만큼 넉넉히 가져온다.
          take: WINDOW * Math.max(1, listingsForSlug(app.slug).length),
        }) as unknown as Promise<(ConsoleMetricDaily & { miniAppId: number })[]>)
      : Promise.resolve([] as (ConsoleMetricDaily & { miniAppId: number })[]),
  ]);

  // 콘솔 리스팅이 여럿인 App(예: crossword-puzzle 웹+게임)은 리스팅별 섹션으로 분리.
  const listings = listingsForSlug(app.slug);
  const consoleSections =
    listings.length > 1
      ? listings.map((l) => ({
          key: String(l.miniAppId),
          title: l.label,
          rows: consoleRows.filter((r) => r.miniAppId === l.miniAppId).slice(0, WINDOW),
        }))
      : [{ key: "single", title: undefined as string | undefined, rows: consoleRows.slice(0, WINDOW) }];

  return (
    <div className="space-y-8">
      <WorkspaceSection
        title="제품 지표"
        description="GA4 BigQuery와 AppsInToss 콘솔 스냅샷을 앱 단위로 확인합니다."
      >
        {ga4Rows.length > 0 ? (
          <div className="space-y-6">
            <div>
              <div className="mb-2 text-sm font-semibold text-neutral-700">
                핵심 지표{" "}
                <span className="font-normal text-neutral-400">
                  기준일 {isoDate(ga4Rows[0].date)}
                </span>
              </div>
              <MetricCards latest={ga4Rows[0]} />
            </div>
            <Panel title="플랫폼 비중">
              <PlatformSplit latest={ga4Rows[0]} />
            </Panel>
            <div className="grid gap-4 lg:grid-cols-3">
              <Panel title="국가 Top">
                <TopDimList items={ga4Rows[0].raw?.countries} />
              </Panel>
              <Panel title="기기 유형">
                <TopDimList items={ga4Rows[0].raw?.devices} />
              </Panel>
              <Panel title="OS 버전">
                <TopDimList items={ga4Rows[0].raw?.osVersions} />
              </Panel>
            </div>
            <div>
              <div className="mb-2 text-sm font-semibold text-neutral-700">DAU 추이</div>
              <DauTrend rowsAsc={[...ga4Rows].reverse()} />
            </div>
            <MetricTrendTable rowsDesc={ga4Rows} />
          </div>
        ) : (
          <EmptyState title="수집된 GA4 지표가 없습니다">
            GA4 대상 매핑과 일일 수집 상태를 확인하세요.
          </EmptyState>
        )}
      </WorkspaceSection>

      <WorkspaceSection title="AppsInToss 콘솔 지표">
        {consoleRows.length > 0 ? (
          <div className="space-y-8">
            {consoleSections.map((s) => (
              <ConsoleSection key={s.key} rowsDesc={s.rows} title={s.title} />
            ))}
          </div>
        ) : (
          <EmptyState title="수집된 AppsInToss 콘솔 지표가 없습니다">
            콘솔 앱 매핑과 온디맨드 수집 상태를 확인하세요.
          </EmptyState>
        )}
      </WorkspaceSection>
    </div>
  );
}
