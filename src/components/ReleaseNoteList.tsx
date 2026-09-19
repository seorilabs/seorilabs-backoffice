import React from "react";
import Link from "next/link";

import { ReleaseNoteDialogButton } from "@/components/ReleaseNoteDialogButton";
import type {
  ReleaseNoteBodyLoader,
  ReleaseNoteRef,
  VersionGroup,
} from "@/lib/core/release-note-index";
import {
  RELEASE_MARKET_LABEL,
  type ReleaseMarketKey,
} from "@/lib/core/release-markets";
import { kstDateShort } from "@/lib/format/kst";

// 출시노트 목록의 표시 전용 컴포넌트. 조회는 page 가 하고 여기서는 받은 데이터만 그린다.
// 본문은 싣지 않고 마켓 버튼(팝업 트리거)만 놓는다.

export type ReleaseNoteGroup = VersionGroup<ReleaseNoteRef>;

export interface AppLatestRow {
  appId: string;
  appSlug: string;
  appName: string;
  group: ReleaseNoteGroup;
}

export function EmptyNotes({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center text-sm text-neutral-400">
      {message}
    </div>
  );
}

function VersionCell({ group }: { group: ReleaseNoteGroup }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs font-medium text-white">
        {group.version}
      </span>
      {group.previousVersion && (
        <span className="text-xs text-neutral-400">← {group.previousVersion}</span>
      )}
      <span className="text-xs text-neutral-400">{kstDateShort(group.createdAt)}</span>
    </div>
  );
}

function MarketNoteButtons({
  appName,
  group,
  load,
}: {
  appName: string;
  group: ReleaseNoteGroup;
  load: ReleaseNoteBodyLoader;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {group.notes.map((note) => (
        <ReleaseNoteDialogButton
          key={note.id}
          noteId={note.id}
          load={load}
          appName={appName}
          version={note.version}
          market={note.market}
          previousVersion={note.previousVersion}
          createdAt={kstDateShort(note.createdAt)}
          compareUrl={note.compareUrl}
        />
      ))}
    </div>
  );
}

/** 1단계 미선택 화면 — 앱 한 줄에 최신 태그와 마켓 버튼. */
export function AppLatestTable({
  rows,
  load,
}: {
  rows: AppLatestRow[];
  load: ReleaseNoteBodyLoader;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
            <th className="px-3 py-2 font-medium">앱</th>
            <th className="px-3 py-2 font-medium">최신 버전</th>
            <th className="px-3 py-2 font-medium">마켓별 노트</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.appId} className="border-b border-neutral-100 last:border-0">
              <td className="px-3 py-2 align-top">
                <Link
                  href={`/release-notes?app=${encodeURIComponent(row.appSlug)}`}
                  className="font-medium hover:underline"
                >
                  {row.appName}
                </Link>
              </td>
              <td className="px-3 py-2 align-top">
                <VersionCell group={row.group} />
              </td>
              <td className="px-3 py-2 align-top">
                <MarketNoteButtons appName={row.appName} group={row.group} load={load} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 1단계 선택 화면 — 태그 한 줄에 마켓 버튼. */
export function AppVersionTable({
  appName,
  groups,
  load,
}: {
  appName: string;
  groups: ReleaseNoteGroup[];
  load: ReleaseNoteBodyLoader;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
            <th className="px-3 py-2 font-medium">버전</th>
            <th className="px-3 py-2 font-medium">마켓별 노트</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.version} className="border-b border-neutral-100 last:border-0">
              <td className="px-3 py-2 align-top">
                <VersionCell group={group} />
              </td>
              <td className="px-3 py-2 align-top">
                <MarketNoteButtons appName={appName} group={group} load={load} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 2단계 필터 — 앱이 실제로 가진 마켓만 건수와 함께. */
export function MarketFilterTabs({
  appSlug,
  active,
  total,
  counts,
}: {
  appSlug: string;
  active: ReleaseMarketKey | undefined;
  total: number;
  counts: { key: ReleaseMarketKey; count: number }[];
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-neutral-500">마켓</span>
      <MarketTab appSlug={appSlug} value={undefined} active={!active} label="전체" count={total} />
      {counts.map(({ key, count }) => (
        <MarketTab
          key={key}
          appSlug={appSlug}
          value={key}
          active={active === key}
          label={RELEASE_MARKET_LABEL[key]}
          count={count}
        />
      ))}
    </div>
  );
}

function MarketTab({
  appSlug,
  value,
  active,
  label,
  count,
}: {
  appSlug: string;
  value: ReleaseMarketKey | undefined;
  active: boolean;
  label: string;
  count: number;
}) {
  const query = new URLSearchParams({ app: appSlug });
  if (value) query.set("market", value);
  return (
    <Link
      href={`/release-notes?${query.toString()}`}
      aria-current={active ? "page" : undefined}
      className={`rounded px-2.5 py-1 text-xs font-medium transition ${
        active ? "bg-neutral-900 text-white" : "bg-white text-neutral-600 hover:bg-neutral-100"
      }`}
    >
      {label}
      <span className={`ml-1 ${active ? "text-neutral-300" : "text-neutral-400"}`}>{count}</span>
    </Link>
  );
}
