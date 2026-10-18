import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { AppMetricsContent } from "@/components/analytics/AppMetricsContent";
import { providerMetricSeries } from "@/lib/analytics/report-query";
import { ProviderMetrics } from "@/components/report/ProviderMetrics";
import { lastElapsedMetricDay } from "@/lib/analytics/metric-day";
import { requirePlatformReadAccess, PlatformAccessError } from "@/lib/platform/access";
export default async function AppMetricsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ market?: string }> }) {
 const app = await prisma.app.findFirst({ where: { id: (await params).id, ...visibleAppWhere } }); if (!app) notFound();
 let permitted = true;
 try { await requirePlatformReadAccess(); } catch (error) { if (!(error instanceof PlatformAccessError)) throw error; permitted = false; }
 const series = permitted ? await providerMetricSeries(lastElapsedMetricDay(new Date()), prisma, app.id) : null;
 return <div className="space-y-4"><AppMetricsContent appId={app.id} name={app.displayName} slug={app.slug} opsManifest={app.opsManifest} market={(await searchParams).market} />{series ? <><p className="text-xs text-neutral-600">아래는 최신 자료 분석입니다. 발행 당시의 고정된 수치는 종합 보고서에서 확인하세요.</p><ProviderMetrics series={series} /></> : <p>스토어·광고 보고서는 플랫폼 관리 조회 권한이 필요합니다.</p>}</div>;
}
