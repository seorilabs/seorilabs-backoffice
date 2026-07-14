// 스토어 출시노트 정형화 — 마켓 업로드용 단일 정형 포맷.
// 순수 텍스트 불릿으로만 정리하되, 생성된 번역을 임의로 자르거나 말줄임표로 바꾸지 않는다.
// 스토어 길이 제한은 생성 프롬프트(언어당 480자)에서 지키도록 한다.

import {
  RELEASE_NOTE_LOCALES,
  type ReleaseNoteTranslationsInput,
} from "@/lib/core/release-note-locales";

/** 인라인 마크다운/HTML 제거 → 순수 텍스트 한 줄. */
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [텍스트](url) / 이미지 → 텍스트
    .replace(/<[^>]+>/g, "") // HTML 태그
    .replace(/[*_`~]{1,3}/g, "") // **볼드** __ `code` ~~취소선~~ 마커
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * LLM 출시노트(원문)를 스토어 정형 포맷으로 강제한다.
 * 항상 "- " 로 시작하는 순수 텍스트 불릿을 반환하며 원문 내용은 줄이지 않는다.
 * 빈 입력이면 빈 문자열을 반환(호출부에서 폴백 처리).
 */
export function normalizeStoreNotes(raw: string): string {
  const lines = (raw ?? "")
    .split(/\r?\n/)
    .map((l) => stripInlineMarkdown(l))
    // 헤더(#, ##) / 수평선(---) / 빈 줄 제거 — 불릿 마커 제거 전에 걸러야 '---' 가 살아남지 않는다.
    .filter((l) => l.length > 0 && !/^#{1,6}(\s|$)/.test(l) && !/^-{3,}$/.test(l))
    // 불릿/번호 마커 제거
    .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0);

  return lines.map((line) => `- ${line}`).join("\n");
}

export const RELEASE_NOTES_ASSET_NAME = "release-notes.json";
export const RELEASE_NOTES_ASSET_SCHEMA = "seorilabs.release-notes/v1";

/**
 * 배포 워크플로우가 다운로드할 release-notes.json 본문 생성.
 * 비어있지 않은 언어만 포함. 노트가 하나도 없으면 null(에셋 업로드 스킵).
 */
export function buildReleaseNotesAsset(
  n: { tag: string } & ReleaseNoteTranslationsInput,
): string | null {
  const notes: Record<string, string> = {};
  for (const { field, storeLocale } of RELEASE_NOTE_LOCALES) {
    const body = n[field]?.trim();
    if (body) notes[storeLocale] = body;
  }
  if (Object.keys(notes).length === 0) return null;
  return JSON.stringify(
    { schema: RELEASE_NOTES_ASSET_SCHEMA, version: n.tag, notes },
    null,
    2,
  );
}

/**
 * Google Play Console의 언어별 출시노트 일괄 입력 형식.
 * 번역이 있는 로케일만 <ko-KR>...</ko-KR> 블록으로 반환한다.
 */
export function buildGooglePlayReleaseNotesText(
  input: ReleaseNoteTranslationsInput,
): string {
  return RELEASE_NOTE_LOCALES.flatMap(({ field, storeLocale }) => {
    const body = input[field]?.trim();
    return body ? [`<${storeLocale}>\n${body}\n</${storeLocale}>`] : [];
  }).join("\n");
}
