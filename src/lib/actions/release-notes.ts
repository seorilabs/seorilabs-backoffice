"use server";

import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { visibleReleaseNoteWhere } from "@/lib/domain/app-visibility";
import { releaseNoteTranslations } from "@/lib/core/release-note-locales";
import type { ReleaseNoteBodyResult } from "@/lib/core/release-note-index";

// 출시노트 본문 온디맨드 조회. 목록은 8개 언어 TEXT 를 싣지 않고 메타데이터만 렌더하며,
// 팝업을 열 때 해당 row 본문만 읽는다. 목록 payload 가 태그 수에 비례해 커지는 것을 막는다.

export async function getReleaseNoteBodyAction(noteId: string): Promise<ReleaseNoteBodyResult> {
  try {
    await requireSession();
  } catch {
    return { ok: false, error: "세션이 만료되었습니다. 새로고침 후 다시 시도하세요." };
  }
  const note = await prisma.releaseNote.findFirst({
    where: { id: noteId, ...visibleReleaseNoteWhere },
    select: {
      koKR: true,
      enUS: true,
      jaJP: true,
      zhCN: true,
      zhTW: true,
      deDE: true,
      frFR: true,
      esES: true,
    },
  });
  if (!note) return { ok: false, error: "출시노트를 찾을 수 없습니다." };
  return { ok: true, notes: releaseNoteTranslations(note) };
}
