// 출시노트 목록을 "앱 → 태그 → 마켓" 3단으로 접는 순수 헬퍼.
// 본문(8개 언어 TEXT)은 여기서 다루지 않는다. 목록은 메타데이터만 싣고 본문은 팝업에서
// 필요한 row 만 따로 읽는다.

import type { ReleaseMarket } from "@prisma/client";
import { RELEASE_MARKET_KEY_ORDER, releaseMarketKey } from "@/lib/core/release-markets";
import type { ReleaseNoteTranslations } from "@/lib/core/release-note-locales";

/** 팝업이 본문을 읽을 때의 반환 계약. */
export type ReleaseNoteBodyResult =
  | { ok: true; notes: ReleaseNoteTranslations }
  | { ok: false; error: string };

/**
 * 본문 로더. 실제 구현은 server action 이며 page 가 주입한다.
 * 클라이언트 컴포넌트가 server action 모듈을 직접 import 하지 않게 해 표시 계층을 독립시킨다.
 */
export type ReleaseNoteBodyLoader = (noteId: string) => Promise<ReleaseNoteBodyResult>;

/** 목록 표시에 필요한 최소 필드. Prisma select 결과가 그대로 들어온다. */
export interface ReleaseNoteRef {
  id: string;
  version: string;
  market: ReleaseMarket | null;
  previousVersion: string | null;
  compareUrl: string | null;
  createdAt: Date;
}

export interface VersionGroup<T extends ReleaseNoteRef> {
  version: string;
  /** 같은 태그의 마켓 row 는 기준 태그가 같다 — 채워진 첫 값을 대표로 쓴다. */
  previousVersion: string | null;
  createdAt: Date;
  notes: T[];
}

/** 마켓 버튼 정렬 순서(모르는 값은 뒤로). */
function marketRank(note: ReleaseNoteRef): number {
  const index = (RELEASE_MARKET_KEY_ORDER as readonly string[]).indexOf(
    releaseMarketKey(note.market),
  );
  return index < 0 ? RELEASE_MARKET_KEY_ORDER.length : index;
}

/**
 * (appId, version) 그룹 목록에서 앱별 최신 태그 한 건만 남긴다.
 * 입력은 최신순 정렬을 가정한다(최초 등장 = 최신).
 */
export function latestVersionPerApp<T extends { appId: string; version: string }>(
  groups: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const group of groups) {
    if (seen.has(group.appId)) continue;
    seen.add(group.appId);
    out.push(group);
  }
  return out;
}

/**
 * 마켓 row 들을 태그 단위로 묶어 표 한 줄로 만든다.
 * 입력은 최신순 정렬을 가정하며, 그 순서를 태그 순서로 유지한다.
 */
export function groupNotesByVersion<T extends ReleaseNoteRef>(
  notes: readonly T[],
): VersionGroup<T>[] {
  const groups = new Map<string, VersionGroup<T>>();
  for (const note of notes) {
    const group = groups.get(note.version);
    if (!group) {
      groups.set(note.version, {
        version: note.version,
        previousVersion: note.previousVersion,
        createdAt: note.createdAt,
        notes: [note],
      });
      continue;
    }
    group.notes.push(note);
    if (note.createdAt > group.createdAt) group.createdAt = note.createdAt;
    group.previousVersion ??= note.previousVersion;
  }
  for (const group of groups.values()) {
    group.notes.sort((a, b) => marketRank(a) - marketRank(b));
  }
  return [...groups.values()];
}
