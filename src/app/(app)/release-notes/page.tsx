import Link from "next/link";

import {
  AppLatestTable,
  AppVersionTable,
  EmptyNotes,
  MarketFilterTabs,
  type AppLatestRow,
} from "@/components/ReleaseNoteList";
import { getReleaseNoteBodyAction } from "@/lib/actions/release-notes";
import { groupNotesByVersion, latestVersionPerApp } from "@/lib/core/release-note-index";
import {
  RELEASE_MARKET_KEY_ORDER,
  parseReleaseMarketKey,
  releaseMarketKey,
  releaseMarketWhere,
  type ReleaseMarketKey,
} from "@/lib/core/release-markets";
import { visibleAppWhere, visibleReleaseNoteWhere } from "@/lib/domain/app-visibility";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// 목록은 메타데이터만 조회한다. 8개 언어 본문은 팝업이 열릴 때 그 row 만 따로 읽는다.
const NOTE_SELECT = {
  id: true,
  version: true,
  market: true,
  previousVersion: true,
  compareUrl: true,
  createdAt: true,
} as const;

/** 한 앱의 태그 목록 조회 상한. */
const APP_NOTE_LIMIT = 200;

export default async function ReleaseNotesPage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string; market?: string }>;
}) {
  const sp = await searchParams;

  // 1단계 선택지 = 출시노트가 실제로 있는 앱만.
  const appOptions = await prisma.app.findMany({
    where: { ...visibleAppWhere, releaseNotes: { some: {} } },
    select: { id: true, slug: true, displayName: true },
    orderBy: { displayName: "asc" },
  });
  const selectedApp = appOptions.find((a) => a.slug === sp.app) ?? null;
  // 2단계는 1단계 하위 필터다. 앱 미선택이면 마켓 파라미터를 무시한다.
  const marketFilter = selectedApp ? parseReleaseMarketKey(sp.market) : undefined;

  return (
    <div className="px-4 py-6 sm:p-8">
      <h1 className="text-xl font-semibold">출시노트</h1>
      <p className="mt-1 mb-4 text-sm text-neutral-500">
        릴리즈 태그 기준 유저용 공지 (이전 태그~새 태그 변경분, 8개 언어). 마켓 버튼을 누르면 본문과
        복사 버튼이 열립니다.
      </p>

      <form method="get" className="mb-5 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          앱
          <select
            name="app"
            defaultValue={selectedApp?.slug ?? ""}
            className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-800"
          >
            <option value="">전체 (앱별 최신 버전)</option>
            {appOptions.map((a) => (
              <option key={a.id} value={a.slug}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white" type="submit">
          조회
        </button>
        {selectedApp && (
          <Link
            href="/release-notes"
            className="px-1 py-1.5 text-sm text-neutral-500 hover:underline"
          >
            전체로
          </Link>
        )}
      </form>

      {selectedApp ? (
        <AppNotes app={selectedApp} marketFilter={marketFilter} />
      ) : (
        <LatestByApp />
      )}
    </div>
  );
}

/** 1단계 미선택 — 앱별 최신 태그 한 줄씩. */
async function LatestByApp() {
  const groups = await prisma.releaseNote.groupBy({
    by: ["appId", "version"],
    where: visibleReleaseNoteWhere,
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
  });
  const latest = latestVersionPerApp(groups);
  // 앱별 최신 태그의 마켓 row 만 가져온다. (appId, version) 쌍은 위 groupBy 에서 이미
  // 가시 앱으로 좁혀져 있다.
  const notes = latest.length
    ? await prisma.releaseNote.findMany({
        where: { OR: latest.map(({ appId, version }) => ({ appId, version })) },
        orderBy: { createdAt: "desc" },
        select: { ...NOTE_SELECT, appId: true, app: { select: { displayName: true, slug: true } } },
      })
    : [];

  const byApp = new Map<string, typeof notes>();
  for (const note of notes) {
    const bucket = byApp.get(note.appId);
    if (bucket) bucket.push(note);
    else byApp.set(note.appId, [note]);
  }

  const rows: AppLatestRow[] = latest.flatMap(({ appId }) => {
    const appNotes = byApp.get(appId);
    if (!appNotes?.length) return [];
    const [group] = groupNotesByVersion(appNotes);
    if (!group) return [];
    return [
      {
        appId,
        appSlug: appNotes[0].app.slug,
        appName: appNotes[0].app.displayName,
        group,
      },
    ];
  });

  if (rows.length === 0) {
    return (
      <EmptyNotes message="아직 생성된 출시노트가 없습니다. 릴리즈 태그(v*)를 푸시하면 자동 생성됩니다." />
    );
  }
  return <AppLatestTable rows={rows} load={getReleaseNoteBodyAction} />;
}

/** 1단계 선택 — 해당 앱의 태그 목록 + 2단계 마켓 필터. */
async function AppNotes({
  app,
  marketFilter,
}: {
  app: { id: string; slug: string; displayName: string };
  marketFilter: ReleaseMarketKey | undefined;
}) {
  // 2단계 선택지는 마켓 필터와 무관하게 이 앱이 실제로 가진 마켓만 노출한다.
  const [marketCounts, notes] = await Promise.all([
    prisma.releaseNote.groupBy({
      by: ["market"],
      where: { appId: app.id },
      _count: { _all: true },
    }),
    prisma.releaseNote.findMany({
      where: { appId: app.id, ...releaseMarketWhere(marketFilter) },
      orderBy: { createdAt: "desc" },
      take: APP_NOTE_LIMIT,
      select: NOTE_SELECT,
    }),
  ]);

  const countByKey = new Map<ReleaseMarketKey, number>(
    marketCounts.map((m) => [releaseMarketKey(m.market), m._count._all]),
  );
  const counts = RELEASE_MARKET_KEY_ORDER.filter((key) => countByKey.has(key)).map((key) => ({
    key,
    count: countByKey.get(key) ?? 0,
  }));
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  const groups = groupNotesByVersion(notes);

  return (
    <>
      <MarketFilterTabs
        appSlug={app.slug}
        active={marketFilter}
        total={total}
        counts={counts}
      />
      {groups.length === 0 ? (
        <EmptyNotes message="이 조건에 맞는 출시노트가 없습니다." />
      ) : (
        <AppVersionTable
          appName={app.displayName}
          groups={groups}
          load={getReleaseNoteBodyAction}
        />
      )}
      {notes.length >= APP_NOTE_LIMIT && (
        <p className="mt-2 text-xs text-neutral-400">
          최근 {APP_NOTE_LIMIT}건만 표시합니다. 마켓 필터로 범위를 좁히세요.
        </p>
      )}
    </>
  );
}
