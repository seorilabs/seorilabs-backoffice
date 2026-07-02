// 스토어 출시노트 정형화 — 마켓 업로드용 단일 정형 포맷.
// LLM 이 규칙을 어길 수 있으므로, 프롬프트 규칙과 별개로 코드가 최종 강제한다.
//
// 제약(가장 빡센 Google Play 기준):
//   - 언어당 총 480자 이내(Play 하드캡 500자 - 안전마진 20)
//   - 최대 4개 불릿, 각 불릿 100자 이내
//   - 순수 텍스트: 마크다운 헤더/링크/강조/HTML/이모지 마커 제거, 각 줄 "- " 로 시작
// Play 480 을 만족하면 App Store(whatsNew 4000)·AIT(memo)도 자동 충족한다.

export const STORE_NOTES_MAX_BULLETS = 4;
export const STORE_NOTES_MAX_BULLET_LEN = 100;
export const STORE_NOTES_MAX_TOTAL = 480;

/** 인라인 마크다운/HTML 제거 → 순수 텍스트 한 줄. */
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [텍스트](url) / 이미지 → 텍스트
    .replace(/<[^>]+>/g, "") // HTML 태그
    .replace(/[*_`~]{1,3}/g, "") // **볼드** __ `code` ~~취소선~~ 마커
    .replace(/\s+/g, " ")
    .trim();
}

/** 코드포인트(문자) 수를 반환. JS .length는 UTF-16 유닛 기준이라 서로게이트 페어(이모지 등)를 2로 센다. */
function cpLen(s: string): number {
  return [...s].length;
}

/** max 코드포인트 이내로 자르되 가능하면 단어 경계에서, 초과 시 말줄임(…). */
function clip(s: string, max: number): string {
  if (cpLen(s) <= max) return s;
  const chars = [...s];
  const slice = chars.slice(0, max - 1).join("");
  const lastSpace = slice.lastIndexOf(" ");
  // 공백이 충분히 뒤쪽이면 단어 경계에서 자름(영문). 한글 등 공백 없으면 하드 슬라이스.
  const base = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${base.trimEnd()}…`;
}

/**
 * LLM 출시노트(원문)를 스토어 정형 포맷으로 강제한다.
 * 항상 "- " 로 시작하는 순수 텍스트 불릿(최대 4줄, 각 ≤100자, 총 ≤480자)을 반환.
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

  const bullets: string[] = [];
  for (const line of lines) {
    if (bullets.length >= STORE_NOTES_MAX_BULLETS) break;
    bullets.push(clip(line, STORE_NOTES_MAX_BULLET_LEN));
  }
  if (bullets.length === 0) return "";

  const render = (bs: string[]) => bs.map((b) => `- ${b}`).join("\n");
  let out = render(bullets);
  // 총 코드포인트 초과 시 뒤 불릿부터 제거.
  while (bullets.length > 1 && cpLen(out) > STORE_NOTES_MAX_TOTAL) {
    bullets.pop();
    out = render(bullets);
  }
  // 불릿 1개인데도 초과하면 마지막으로 하드 말줄임.
  if (cpLen(out) > STORE_NOTES_MAX_TOTAL) out = clip(out, STORE_NOTES_MAX_TOTAL);
  return out;
}

// DB 언어키(koKR/enUS) → 스토어 BCP-47 로케일.
const STORE_LOCALE: Record<"koKR" | "enUS", string> = {
  koKR: "ko-KR",
  enUS: "en-US",
};

export const RELEASE_NOTES_ASSET_NAME = "release-notes.json";
export const RELEASE_NOTES_ASSET_SCHEMA = "seorilabs.release-notes/v1";

/**
 * 배포 워크플로우가 다운로드할 release-notes.json 본문 생성.
 * 비어있지 않은 언어만 포함. 노트가 하나도 없으면 null(에셋 업로드 스킵).
 */
export function buildReleaseNotesAsset(n: {
  tag: string;
  koKR: string;
  enUS: string;
}): string | null {
  const notes: Record<string, string> = {};
  if (n.koKR.trim()) notes[STORE_LOCALE.koKR] = n.koKR.trim();
  if (n.enUS.trim()) notes[STORE_LOCALE.enUS] = n.enUS.trim();
  if (Object.keys(notes).length === 0) return null;
  return JSON.stringify(
    { schema: RELEASE_NOTES_ASSET_SCHEMA, version: n.tag, notes },
    null,
    2,
  );
}
