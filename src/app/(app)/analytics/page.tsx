import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { resolveGa4Target, isoDate } from "@/lib/ga4/datasets";
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
import { resolveAitTarget, listingsForSlug, primaryListingForSlug } from "@/lib/analytics/ait-apps";
import { ConsoleSection, type ConsoleMetricDaily } from "@/components/analytics/ConsolePanels";
import {
  aggConsoleWindow,
  formatConsoleWindowRow,
  rankConsoleWindows,
} from "@/lib/analytics/console-window";

export const dynamic = "force-dynamic";

const WINDOW = 28;

const pct = (v: number | null): string => (v == null ? "—" : `${v}%`);

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string; market?: string }>;
}) {
  const sp = await searchParams;

  const allApps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      slug: true,
      displayName: true,
      firebaseProject: true,
      ga4Dataset: true,
      aitWorkspaceId: true,
      aitMiniAppId: true,
      opsManifest: true,
    },
  });
  // 탭 = GA4 대상 ∪ 콘솔 대상. 개요는 소스별로 각각 렌더한다.
  const ga4Apps = allApps.filter((a) => resolveGa4Target(a));
  const consoleApps = allApps.filter((a) => resolveAitTarget(a));
  const apps = allApps.filter((a) => resolveGa4Target(a) || resolveAitTarget(a));
  const selected = apps.find((a) => a.slug === sp.app) ?? null;

  return (
    <div className="px-4 py-6 sm:p-8">
      <h1 className="text-xl font-semibold">앱 지표</h1>
      <p className="mt-1 mb-4 text-sm text-neutral-500">
        GA4(BigQuery, 매일 수집) + AppsInToss 콘솔(온디맨드 수집) 일별 스냅샷 · 기준일 D-1(전일 확정)
      </p>

      {/* 앱 선택 탭 */}
      <div className="mb-5 flex flex-wrap gap-1.5">
        <TabLink href="/analytics" active={!selected} label="전체" />
        {apps.map((a) => (
          <TabLink
            key={a.id}
            href={`/analytics?app=${a.slug}`}
            active={selected?.id === a.id}
            label={a.displayName}
          />
        ))}
      </div>

      {apps.length === 0 ? (
        <Notice>지표 대상 앱이 없습니다. (GA4 ga4Dataset 매핑 또는 콘솔 aitMiniAppId/ait-apps 표 확인)</Notice>
      ) : selected ? (
        <SelectedApp
          appId={selected.id}
          name={selected.displayName}
          slug={selected.slug}
          opsManifest={selected.opsManifest}
          market={sp.market}
        />
      ) : (
        <Overview ga4Apps={ga4Apps} consoleApps={consoleApps} />
      )}
    </div>
  );
}

async function SelectedApp({
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
    <ContentMetrics
      appId={appId}
      slug={slug}
      opsManifest={opsManifest}
      market={market}
    />
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
          핵심 지표 <span className="text-neutral-400">(기준일 {isoDate(latest.date)})</span>
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
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">DAU 추이 (최근 {rowsAsc.length}일)</div>
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
          <span className="font-normal text-neutral-400"> (기준일 {isoDate(rowsDesc[0].date)})</span>
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
        {row && <span className="font-normal text-neutral-400">(기준일 {isoDate(row.date)})</span>}
      </div>
      <ContentMarketTabs spec={spec} appSlug={slug} selected={selectedMarket} />
      {row ? (
        <ContentSection spec={spec} snapshot={row.raw as unknown as ContentMetricSnapshot} />
      ) : (
        <Notice>수집된 컨텐츠 세부 지표가 아직 없습니다. 다음 수집(10:15 KST) 이후 표시됩니다.</Notice>
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

type AppRef = { id: string; slug: string; displayName: string };

async function Overview({ ga4Apps, consoleApps }: { ga4Apps: AppRef[]; consoleApps: AppRef[] }) {
  const [ga4Items, consoleItems, consoleWindows] = await Promise.all([
    Promise.all(
      ga4Apps.map(async (a) => ({
        app: a,
        latest: (await prisma.appMetricDaily.findFirst({
          where: { appId: a.id },
          orderBy: { date: "desc" },
        })) as unknown as MetricDaily | null,
      })),
    ),
    // 개요 단일값은 primary 리스팅만(한 App 에 리스팅이 여럿이면 섞이지 않게 miniAppId 로 스코프).
    Promise.all(
      consoleApps.map(async (a) => ({
        app: a,
        latest: (await prisma.appConsoleMetricDaily.findFirst({
          where: { appId: a.id, miniAppId: primaryListingForSlug(a.slug)?.miniAppId },
          orderBy: { date: "desc" },
        })) as unknown as ConsoleMetricDaily | null,
      })),
    ),
    // 최근 7일 집계(앱별 primary 리스팅 최근 7개 수집 row).
    Promise.all(
      consoleApps.map(async (a) => ({
        app: a,
        agg: aggConsoleWindow(
          (await prisma.appConsoleMetricDaily.findMany({
            where: { appId: a.id, miniAppId: primaryListingForSlug(a.slug)?.miniAppId },
            orderBy: { date: "desc" },
            take: 7,
          })) as unknown as ConsoleMetricDaily[],
        ),
      })),
    ),
  ]);

  // 최근 7일 집계 비교는 DAU 합 내림차순(데이터 없는 앱은 뒤).
  const windowRanked = rankConsoleWindows(consoleWindows);

  return (
    <div className="space-y-6">
      {ga4Apps.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-semibold text-neutral-700">GA4 지표</div>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
                  <th className="px-3 py-2">앱</th>
                  <th className="px-3 py-2">기준일</th>
                  <th className="px-3 py-2 text-right">DAU</th>
                  <th className="px-3 py-2 text-right">신규</th>
                  <th className="px-3 py-2 text-right">D1</th>
                  <th className="px-3 py-2 text-right">D7</th>
                  <th className="px-3 py-2 text-right">CTA 노출</th>
                  <th className="px-3 py-2 text-right">완료</th>
                  <th className="px-3 py-2 text-right">실제 노출</th>
                </tr>
              </thead>
              <tbody>
                {ga4Items.map(({ app, latest }) => (
                  <tr key={app.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                    <td className="px-3 py-2">
                      <Link href={`/analytics?app=${app.slug}`} className="font-medium hover:underline">
                        {app.displayName}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-500">{latest ? isoDate(latest.date) : "—"}</td>
                    <td className="px-3 py-2 text-right">{latest ? latest.dau : "—"}</td>
                    <td className="px-3 py-2 text-right">{latest ? latest.newUsers : "—"}</td>
                    <td className="px-3 py-2 text-right text-neutral-600">{latest ? pct(latest.d1Pct) : "—"}</td>
                    <td className="px-3 py-2 text-right text-neutral-600">{latest ? pct(latest.d7Pct) : "—"}</td>
                    <td className="px-3 py-2 text-right text-neutral-600">
                      {latest ? latest.adCtaImpressions : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-600">
                      {latest ? latest.adCompletions : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-600">
                      {latest ? latest.networkAdImpressions : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {consoleApps.length > 0 && (
        <div className="space-y-6">
          {/* 최근 7일 집계 비교(내가 보여준 앱 전체 비교표) */}
          <div>
            <div className="mb-2 text-sm font-semibold text-neutral-700">
              AppsInToss 콘솔 지표 · 최근 7일 집계
            </div>
            <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
                    <th className="px-3 py-2">앱</th>
                    <th className="px-3 py-2">기간</th>
                    <th className="px-3 py-2 text-right">DAU 합</th>
                    <th className="px-3 py-2 text-right">일평균</th>
                    <th className="px-3 py-2 text-right">신규</th>
                    <th className="px-3 py-2 text-right">세션(평균)</th>
                    <th className="px-3 py-2 text-right">광고노출</th>
                    <th className="px-3 py-2 text-right">광고수익</th>
                  </tr>
                </thead>
                <tbody>
                  {windowRanked.map(({ app, agg }) => {
                    const d = formatConsoleWindowRow(agg, isoDate);
                    return (
                      <tr key={app.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                        <td className="px-3 py-2">
                          <Link href={`/analytics?app=${app.slug}`} className="font-medium hover:underline">
                            {app.displayName}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-xs text-neutral-500">{d.period}</td>
                        <td className="px-3 py-2 text-right">{d.dauSum}</td>
                        <td className="px-3 py-2 text-right text-neutral-600">{d.dauAvg}</td>
                        <td className="px-3 py-2 text-right">{d.newSum}</td>
                        <td className="px-3 py-2 text-right text-neutral-600">{d.sessAvg}</td>
                        <td className="px-3 py-2 text-right text-neutral-600">{d.iaaImpSum}</td>
                        <td className="px-3 py-2 text-right text-neutral-600">{d.iaaEarnKrw}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 최신 기준일 스냅샷 */}
          <div>
            <div className="mb-2 text-sm font-semibold text-neutral-700">
              AppsInToss 콘솔 지표 · 최신 기준일
            </div>
            <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
                    <th className="px-3 py-2">앱</th>
                    <th className="px-3 py-2">기준일</th>
                    <th className="px-3 py-2 text-right">DAU</th>
                    <th className="px-3 py-2 text-right">신규</th>
                    <th className="px-3 py-2 text-right">세션</th>
                    <th className="px-3 py-2 text-right">광고노출</th>
                    <th className="px-3 py-2 text-right">광고수익</th>
                  </tr>
                </thead>
                <tbody>
                  {consoleItems.map(({ app, latest }) => (
                    <tr key={app.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                      <td className="px-3 py-2">
                        <Link href={`/analytics?app=${app.slug}`} className="font-medium hover:underline">
                          {app.displayName}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-xs text-neutral-500">{latest ? isoDate(latest.date) : "—"}</td>
                      <td className="px-3 py-2 text-right">{latest ? latest.dau : "—"}</td>
                      <td className="px-3 py-2 text-right">{latest ? latest.newUsers : "—"}</td>
                      <td className="px-3 py-2 text-right text-neutral-600">
                        {latest?.avgSessionSec != null ? `${Math.round(latest.avgSessionSec)}초` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-neutral-600">{latest ? latest.iaaImpressions : "—"}</td>
                      <td className="px-3 py-2 text-right text-neutral-600">
                        {latest ? `₩${Math.round(latest.iaaEarningKrw).toLocaleString("ko-KR")}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TabLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded px-3 py-1.5 text-sm font-medium transition ${
        active ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
      }`}
    >
      {label}
    </Link>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
      {children}
    </div>
  );
}
