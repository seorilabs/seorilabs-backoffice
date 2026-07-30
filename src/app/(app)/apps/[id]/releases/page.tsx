import { notFound } from "next/navigation";

import { EmptyState, Panel, WorkspaceSection } from "@/components/app-ops/WorkspaceUi";
import { Pill } from "@/components/badges";
import { ReleaseControls } from "@/components/ReleaseControls";
import { ReleaseNoteCard } from "@/components/ReleaseNoteCard";
import { releaseNoteTranslations } from "@/lib/core/release-note-locales";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { asStringArray, fmtDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export default async function AppReleasesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const app = await prisma.app.findFirst({
    where: { id, ...visibleAppWhere },
    include: {
      releases: { orderBy: { updatedAt: "desc" }, take: 50 },
      releaseNotes: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!app) notFound();
  const targets = asStringArray(app.marketTargets);

  return (
    <div className="space-y-8">
      <WorkspaceSection
        title="릴리스 실행"
        description="명시적 태그를 만들고 마켓별 배포 workflow를 시작합니다."
      >
        <Panel>
          <ReleaseControls appId={app.id} targets={targets} />
        </Panel>
      </WorkspaceSection>

      <WorkspaceSection title="배포 이력">
        {app.releases.length > 0 ? (
          <Panel>
            <div className="divide-y divide-neutral-100">
              {app.releases.map((release) => (
                <div
                  key={release.id}
                  className="flex items-center justify-between gap-4 py-2 text-sm"
                >
                  <span>
                    <b>{release.version}</b>
                    <span className="mx-2 text-neutral-500">{release.market}</span>
                    <Pill
                      tone={
                        release.status === "SUCCEEDED"
                          ? "green"
                          : release.status === "FAILED"
                            ? "red"
                            : "amber"
                      }
                    >
                      {release.status}
                    </Pill>
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">
                    {fmtDate(release.deployedAt)}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        ) : (
          <EmptyState title="배포 이력이 없습니다">첫 릴리스 실행 후 표시됩니다.</EmptyState>
        )}
      </WorkspaceSection>

      <WorkspaceSection title="출시노트">
        {app.releaseNotes.length > 0 ? (
          <div className="space-y-3">
            {app.releaseNotes.map((note) => (
              <ReleaseNoteCard
                key={note.id}
                appName={app.displayName}
                appId={app.id}
                version={note.version}
                previousVersion={note.previousVersion}
                createdAt={fmtDate(note.createdAt)}
                compareUrl={note.compareUrl}
                {...releaseNoteTranslations(note)}
              />
            ))}
          </div>
        ) : (
          <EmptyState title="출시노트가 없습니다">릴리스 태그 생성 후 자동 생성됩니다.</EmptyState>
        )}
      </WorkspaceSection>
    </div>
  );
}
