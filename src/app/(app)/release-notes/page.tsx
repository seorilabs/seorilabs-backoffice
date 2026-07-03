import { prisma } from "@/lib/prisma";
import { fmtDate } from "@/lib/format";
import { visibleReleaseNoteWhere } from "@/lib/domain/app-visibility";
import { ReleaseNoteCard } from "@/components/ReleaseNoteCard";

export const dynamic = "force-dynamic";

export default async function ReleaseNotesPage() {
  const notes = await prisma.releaseNote.findMany({
    where: visibleReleaseNoteWhere,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { app: { select: { displayName: true, id: true } } },
  });

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">출시노트</h1>
      <p className="mt-1 mb-4 text-sm text-neutral-500">
        릴리즈 태그 기준 유저용 공지 (이전 태그~새 태그 변경분, ko/en). 최신순.
      </p>

      {notes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center text-sm text-neutral-400">
          아직 생성된 출시노트가 없습니다. 릴리즈 태그(v*)를 푸시하면 자동 생성됩니다.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {notes.map((n) => (
            <ReleaseNoteCard
              key={n.id}
              appName={n.app.displayName}
              appId={n.app.id}
              version={n.version}
              previousVersion={n.previousVersion}
              createdAt={fmtDate(n.createdAt)}
              compareUrl={n.compareUrl}
              koKR={n.koKR}
              enUS={n.enUS}
            />
          ))}
        </div>
      )}
    </div>
  );
}
