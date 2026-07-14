import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStoreNotes,
  buildReleaseNotesAsset,
  RELEASE_NOTES_ASSET_SCHEMA,
} from "./store-notes";

test("불릿 마커/마크다운을 순수 텍스트 '- ' 불릿으로 정규화", () => {
  const out = normalizeStoreNotes(
    "## 이번 업데이트\n* **새 기능** 추가\n- [자세히](https://x)\n1) 버그 수정",
  );
  const lines = out.split("\n");
  assert.ok(lines.every((l) => l.startsWith("- ")));
  assert.ok(!out.includes("#"));
  assert.ok(!out.includes("*"));
  assert.ok(!out.includes("["));
  assert.ok(out.includes("새 기능 추가"));
  assert.ok(out.includes("자세히"));
});

test("불릿 개수와 내용을 줄이지 않는다", () => {
  const raw = Array.from({ length: 10 }, (_, i) => `- 항목 ${i}`).join("\n");
  const out = normalizeStoreNotes(raw);
  assert.equal(out.split("\n").length, 10);
  assert.match(out, /항목 9$/);
});

test("긴 번역도 말줄임표 없이 전체 내용을 보존한다", () => {
  const long = "가".repeat(600);
  const out = normalizeStoreNotes(long);
  assert.equal(out, `- ${long}`);
  assert.ok(!out.includes("…"));
});

test("빈/공백 입력은 빈 문자열", () => {
  assert.equal(normalizeStoreNotes(""), "");
  assert.equal(normalizeStoreNotes("\n  \n---\n## 헤더만"), "");
});

test("buildReleaseNotesAsset: 비어있지 않은 언어만 포함", () => {
  const json = buildReleaseNotesAsset({
    tag: "v1.2.3",
    koKR: "- 개선",
    enUS: "",
    jaJP: "- 改善",
    zhCN: "- 改进",
    zhTW: "- 改善",
    deDE: "- Verbessert",
    frFR: "- Améliorations",
    esES: "- Mejoras",
  });
  assert.ok(json);
  const parsed = JSON.parse(json!);
  assert.equal(parsed.schema, RELEASE_NOTES_ASSET_SCHEMA);
  assert.equal(parsed.version, "v1.2.3");
  assert.deepEqual(Object.keys(parsed.notes), [
    "ko-KR",
    "ja-JP",
    "zh-CN",
    "zh-TW",
    "de-DE",
    "fr-FR",
    "es-ES",
  ]);
  assert.equal(parsed.notes["ko-KR"], "- 개선");
  assert.equal(parsed.notes["ja-JP"], "- 改善");
});

test("buildReleaseNotesAsset: 노트 없으면 null", () => {
  assert.equal(buildReleaseNotesAsset({ tag: "v1.0.0", koKR: "", enUS: "  " }), null);
});
