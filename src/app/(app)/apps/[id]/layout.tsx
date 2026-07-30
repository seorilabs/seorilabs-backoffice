import { notFound } from "next/navigation";

import { AppWorkspaceShell } from "@/components/app-ops/AppWorkspaceShell";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { prisma } from "@/lib/prisma";
import { buildAppWorkspaceTabs } from "@/lib/app-ops/workspace";

export const dynamic = "force-dynamic";

export default async function AppWorkspaceLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;
  const app = await prisma.app.findFirst({
    where: { id, ...visibleAppWhere },
    select: {
      id: true,
      slug: true,
      displayName: true,
      repoFullName: true,
      type: true,
      engine: true,
      currentStage: true,
      status: true,
      firebaseProject: true,
      ga4Dataset: true,
      aitWorkspaceId: true,
      aitMiniAppId: true,
      opsManifest: true,
      opsManifestError: true,
    },
  });
  if (!app) notFound();

  return (
    <AppWorkspaceShell app={app} tabs={buildAppWorkspaceTabs(app)}>
      {children}
    </AppWorkspaceShell>
  );
}
