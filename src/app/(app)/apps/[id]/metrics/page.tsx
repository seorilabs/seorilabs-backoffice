import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { AppMetricsContent } from "@/components/analytics/AppMetricsContent";
export default async function AppMetricsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ market?: string }> }) {
 const app = await prisma.app.findFirst({ where: { id: (await params).id, ...visibleAppWhere } }); if (!app) notFound();
 return <AppMetricsContent appId={app.id} name={app.displayName} slug={app.slug} opsManifest={app.opsManifest} market={(await searchParams).market} />;
}
