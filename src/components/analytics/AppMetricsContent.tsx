import { prisma } from "@/lib/prisma";
import { dbDay } from "@/lib/analytics/metric-day";
import {
  MetricCards,
  DauTrend,
  MetricTrendTable,
  PlatformSplit,
  TopDimList,
  type MetricDaily,
} from "@/components/analytics/MetricPanels";
// 범용(스펙 구동) 앱 컨텐츠 세부 지표 — 모든 게임의 단일 렌더러. lucid-chess/happy-farm/
// foam-party/crossword-puzzle 등 스펙(content-registry)이 등록된 앱은 모두 이 경로로 렌더된다.
import { ContentSection, ContentMarketTabs } from "@/components/analytics/AppContentPanels";
import { resolveAppContentSpec } from "@/lib/app-ops/content-spec";
import { parseMarket } from "@/lib/analytics/market";
import type { ContentMetricSnapshot } from "@/lib/analytics/content-source";
import { listingsForSlug } from "@/lib/analytics/ait-apps";
import { ConsoleSection, type ConsoleMetricDaily } from "@/components/analytics/ConsolePanels";

const WINDOW = 28;

export async function AppMetricsContent({
  appId,
  name,
  slug,
  opsManifest,
  market,
}: {
  appId: string;
  name: string;
  slug: string;
  opsManifest: unknown;
  market?: string;
}) {
  const rowsDesc = (await prisma.appMetricDaily.findMany({
    where: { appId },
    orderBy: { date: "desc" },
    take: WINDOW,
  })) as unknown as MetricDaily[];

  // 컨텐츠 세부 지표 섹션(스펙 등록 앱만). 공통 지표가 비어 있어도 노출한다.
  const contentSection = (
    <ContentMetrics appId={appId} slug={slug} opsManifest={opsManifest} market={market} />
  );

  if (rowsDesc.length === 0) {
    return (
      <div className="space-y-6">
        <Notice>{name}의 수집된 GA4 공통 지표가 아직 없습니다. 수집 후 표시됩니다.</Notice>
        <ConsoleMetricsSection appId={appId} slug={slug} />
        {contentSection}
      </div>
    );
  }
  const latest = rowsDesc[0];
  const rowsAsc = [...rowsDesc].reverse();
  const bd = latest.raw ?? {};

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">
          핵심 지표 <span className="text-neutral-400">(기준일 {dbDay(latest.date)})</span>
        </div>
        <MetricCards latest={latest} />
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">플랫폼 비중 (DAU)</div>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <PlatformSplit latest={latest} />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="국가 Top (DAU)">
          <TopDimList items={bd.countries} empty="국가 데이터 없음" />
        </Panel>
        <Panel title="기기 유형 (DAU)">
          <TopDimList items={bd.devices} empty="기기 데이터 없음" />
        </Panel>
        <Panel title="OS 버전 (DAU)">
          <TopDimList items={bd.osVersions} empty="OS 데이터 없음" />
        </Panel>
        <Panel title="최초 획득 경로 (DAU)">
          <TopDimList items={bd.acquisition} empty="획득 경로 미수집" />
        </Panel>
        <Panel title="개발·테스트 표시 (DAU)">
          <p className="mb-2 text-xs text-neutral-500">
            표시가 없는 이벤트도 운영 사용자로 확정할 수 없습니다. 같은 사용자는 여러 항목에 포함될
            수 있습니다.
          </p>
          <TopDimList items={bd.trafficClass} empty="구분 미수집" />
        </Panel>
        <Panel title="수집 경로 (DAU)">
          <TopDimList items={bd.streams} />
        </Panel>
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">
          DAU 추이 (최근 {rowsAsc.length}일)
        </div>
        <DauTrend rowsAsc={rowsAsc} />
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">일별 상세</div>
        <MetricTrendTable rowsDesc={rowsDesc} />
      </div>
      <ConsoleMetricsSection appId={appId} slug={slug} />
      {contentSection}
    </div>
  );
}

// AppsInToss 콘솔 지표 섹션(온디맨드 수집). GA4 유무와 무관하게 렌더 — 콘솔 데이터가 있으면
// 카드/추이/유입경로/데모를, 없으면 안내를 보인다. 한 App 에 콘솔 리스팅이 여럿이면(예:
// crossword-puzzle 웹+네이티브 게임) 리스팅별로 섹션을 나눠 보인다.
async function ConsoleMetricsSection({ appId, slug }: { appId: string; slug: string }) {
  const listings = listingsForSlug(slug);
  const rowsDesc = (await prisma.appConsoleMetricDaily.findMany({
    where: { appId },
    orderBy: { date: "desc" },
    take: WINDOW * Math.max(1, listings.length),
  })) as unknown as (ConsoleMetricDaily & { miniAppId: number })[];

  // 리스팅이 0~1개면 단일 섹션(기존 동작). 여럿이면 리스팅별로 필터해 각각 렌더.
  const multi = listings.length > 1;
  const sections: { key: string; title?: string; rows: ConsoleMetricDaily[] }[] = multi
    ? listings.map((l) => ({
        key: String(l.miniAppId),
        title: l.label,
        rows: rowsDesc.filter((r) => r.miniAppId === l.miniAppId).slice(0, WINDOW),
      }))
    : [{ key: "single", rows: rowsDesc.slice(0, WINDOW) }];

  return (
    <div className="border-t border-neutral-200 pt-6">
      <div className="mb-3 text-sm font-semibold text-neutral-800">
        AppsInToss 콘솔 지표
        {!multi && rowsDesc.length > 0 && (
          <span className="font-normal text-neutral-400"> (기준일 {dbDay(rowsDesc[0].date)})</span>
        )}
      </div>
      <div className="space-y-8">
        {sections.map((s) => (
          <ConsoleSection key={s.key} rowsDesc={s.rows} title={s.title} />
        ))}
      </div>
    </div>
  );
}

// 앱 컨텐츠 세부 지표 섹션(스펙 구동 단일 경로). 컨텐츠 스펙이 등록된 앱만 렌더한다.
// 스펙이 마켓을 선언하면 마켓 탭 + 선택 마켓 스냅샷을, 아니면 통합('all') 스냅샷을 보인다.
// 스펙 없는 앱은 공통 지표만 보이고 이 섹션은 조용히 생략된다.
async function ContentMetrics({
  appId,
  slug,
  opsManifest,
  market,
}: {
  appId: string;
  slug: string;
  opsManifest: unknown;
  market?: string;
}) {
  const spec = resolveAppContentSpec(slug, opsManifest);
  if (!spec) return null;
  const selectedMarket = parseMarket(spec, market);
  const row = await prisma.appContentMetricDaily.findFirst({
    where: { appId, market: selectedMarket },
    orderBy: { date: "desc" },
  });
  return (
    <div className="border-t border-neutral-200 pt-6">
      <div className="mb-3 text-sm font-semibold text-neutral-800">
        컨텐츠 세부 지표{" "}
        {row && <span className="font-normal text-neutral-400">(기준일 {dbDay(row.date)})</span>}
      </div>
      <ContentMarketTabs
        spec={spec}
        appSlug={slug}
        selected={selectedMarket}
        hrefBase={`/apps/${appId}/metrics`}
      />
      {row ? (
        <ContentSection spec={spec} snapshot={row.raw as unknown as ContentMetricSnapshot} />
      ) : (
        <Notice>
          수집된 컨텐츠 세부 지표가 아직 없습니다. 다음 수집(10:15 KST) 이후 표시됩니다.
        </Notice>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-neutral-700">{title}</div>
      {children}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-neutral-200 bg-white p-4 text-sm text-neutral-500">
      {children}
    </div>
  );
}
