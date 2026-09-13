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
export const RELEASE_NOTES_ASSET_SCHEMA_V2 = "seorilabs.release-notes/v2";

/** asset 의 markets 섹션 키 — Prisma enum 과 분리해 워크플로/문서용 안정 문자열. */
export const RELEASE_NOTES_ASSET_MARKETS = ["googlePlay", "appStore", "appsInToss"] as const;
export type ReleaseNotesAssetMarket = (typeof RELEASE_NOTES_ASSET_MARKETS)[number];

/**
 * 단일 마켓 row 의 koKR/enUS/... → 스토어 locale 코드 → 본문 map. 비어있지 않은 locale 만.
 */
function buildMarketSection(translations: ReleaseNoteTranslationsInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { field, storeLocale } of RELEASE_NOTE_LOCALES) {
    const body = translations[field]?.trim();
    if (body) out[storeLocale] = body;
  }
  return out;
}

/**
 * 배포 워크플로우가 다운로드할 release-notes.json 본문 생성. v2 포맷.
 *
 * 구조:
 *   {
 *     schema: "seorilabs.release-notes/v2",
 *     version: "v1.0.29",
 *     notes: { "ko-KR": "...", ... },        // 레거시 fallback (3 마켓 row 의 합집합)
 *     markets: {
 *       googlePlay:  { "ko-KR": "...", ... },
 *       appStore:    { "ko-KR": "...", ... },
 *       appsInToss:  { "ko-KR": "...", ... },
 *     },
 *   }
 *
 * 입력은 마켓별 row 3건. 마켓 row 가 비어있으면 그 마켓 키는 `markets` 섹션에서 생략
 * (consumer 가 키 부재로 누락 마켓을 감지). 비어있지 않은 마켓 섹션이 하나도 없고
 * 레거시 합집합도 비어있으면 null 반환(에셋 스킵).
 */
export interface BuildReleaseNotesAssetInput {
  tag: string;
  /** 마켓별 row 가 없으면 undefined. 정의된 마켓만 채운다. */
  markets: Partial<Record<ReleaseNotesAssetMarket, ReleaseNoteTranslationsInput>>;
}

export function buildReleaseNotesAsset(input: BuildReleaseNotesAssetInput): string | null {
  const marketsSection: Record<string, Record<string, string>> = {};
  for (const market of RELEASE_NOTES_ASSET_MARKETS) {
    const tr = input.markets[market];
    if (!tr) continue;
    const section = buildMarketSection(tr);
    if (Object.keys(section).length > 0) marketsSection[market] = section;
  }

  // 레거시 `notes` = 마켓 row 합집합 (마켓과 무관한 항목 fallback). 비어있지 않은 locale 만.
  const notesSection: Record<string, string> = {};
  for (const { field, storeLocale } of RELEASE_NOTE_LOCALES) {
    const seen = new Set<string>();
    for (const market of RELEASE_NOTES_ASSET_MARKETS) {
      const tr = input.markets[market];
      if (!tr) continue;
      const body = tr[field]?.trim();
      if (!body || seen.has(body)) continue;
      if (!notesSection[storeLocale]) notesSection[storeLocale] = body;
      seen.add(body);
    }
  }

  if (Object.keys(marketsSection).length === 0 && Object.keys(notesSection).length === 0) {
    return null;
  }
  return JSON.stringify(
    {
      schema: RELEASE_NOTES_ASSET_SCHEMA_V2,
      version: input.tag,
      notes: notesSection,
      markets: marketsSection,
    },
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
