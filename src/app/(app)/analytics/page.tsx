import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { resolveGa4Target, isoDate } from "@/lib/ga4/datasets";
import {
  MetricCards,
  DauTrend,
  MetricTrendTable,
  type MetricDaily,
} from "@/components/analytics/MetricPanels";

export const dynamic = "force-dynamic";

const WINDOW = 28;

const pct = (v: number | null): string => (v == null ? "—" : `${v}%`);

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string }>;
}) {
  const sp = await searchParams;

  const allApps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: { id: true, slug: true, displayName: true, firebaseProject: true, ga4Dataset: true },
  });
  const apps = allApps.filter((a) => resolveGa4Target(a));
  const selected = apps.find((a) => a.slug === sp.app) ?? null;

  return (
    <div className="px-4 py-6 sm:p-8">
      <h1 className="text-xl font-semibold">앱 지표</h1>
      <p className="mt-1 mb-4 text-sm text-neutral-500">
        GA4 → BigQuery 일별 스냅샷 · 기준일 D-1(전일 확정) · 매일 21:00 KST 수집
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
        <Notice>GA4 지표 대상 앱이 없습니다. (App.ga4Dataset 매핑 또는 fallback 표 확인)</Notice>
      ) : selected ? (
        <SelectedApp appId={selected.id} name={selected.displayName} />
      ) : (
        <Overview apps={apps} />
      )}
    </div>
  );
}

async function SelectedApp({ appId, name }: { appId: string; name: string }) {
  const rowsDesc = (await prisma.appMetricDaily.findMany({
    where: { appId },
    orderBy: { date: "desc" },
    take: WINDOW,
  })) as MetricDaily[];

  if (rowsDesc.length === 0) {
    return <Notice>{name}의 수집된 지표가 아직 없습니다. 수집 후 표시됩니다.</Notice>;
  }
  const latest = rowsDesc[0];
  const rowsAsc = [...rowsDesc].reverse();

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">
          핵심 지표 <span className="text-neutral-400">(기준일 {isoDate(latest.date)})</span>
        </div>
        <MetricCards latest={latest} />
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">DAU 추이 (최근 {rowsAsc.length}일)</div>
        <DauTrend rowsAsc={rowsAsc} />
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-neutral-700">일별 상세</div>
        <MetricTrendTable rowsDesc={rowsDesc} />
      </div>
    </div>
  );
}

async function Overview({
  apps,
}: {
  apps: { id: string; slug: string; displayName: string }[];
}) {
  const items = await Promise.all(
    apps.map(async (a) => ({
      app: a,
      latest: (await prisma.appMetricDaily.findFirst({
        where: { appId: a.id },
        orderBy: { date: "desc" },
      })) as MetricDaily | null,
    })),
  );

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-3 py-2">앱</th>
            <th className="px-3 py-2">기준일</th>
            <th className="px-3 py-2 text-right">DAU</th>
            <th className="px-3 py-2 text-right">신규</th>
            <th className="px-3 py-2 text-right">D1</th>
            <th className="px-3 py-2 text-right">D7</th>
            <th className="px-3 py-2 text-right">광고노출</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ app, latest }) => (
            <tr key={app.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
              <td className="px-3 py-2">
                <Link href={`/analytics?app=${app.slug}`} className="font-medium hover:underline">
                  {app.displayName}
                </Link>
              </td>
              <td className="px-3 py-2 text-xs text-neutral-500">
                {latest ? isoDate(latest.date) : "—"}
              </td>
              <td className="px-3 py-2 text-right">{latest ? latest.dau : "—"}</td>
              <td className="px-3 py-2 text-right">{latest ? latest.newUsers : "—"}</td>
              <td className="px-3 py-2 text-right text-neutral-600">{latest ? pct(latest.d1Pct) : "—"}</td>
              <td className="px-3 py-2 text-right text-neutral-600">{latest ? pct(latest.d7Pct) : "—"}</td>
              <td className="px-3 py-2 text-right text-neutral-600">{latest ? latest.adImpressions : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
