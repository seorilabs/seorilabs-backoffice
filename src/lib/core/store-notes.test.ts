import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStoreNotes,
  buildReleaseNotesAsset,
  STORE_NOTES_MAX_TOTAL,
  STORE_NOTES_MAX_BULLETS,
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

test("불릿 개수를 최대치로 제한", () => {
  const raw = Array.from({ length: 10 }, (_, i) => `- 항목 ${i}`).join("\n");
  const out = normalizeStoreNotes(raw);
  assert.equal(out.split("\n").length, STORE_NOTES_MAX_BULLETS);
});

test("총 코드포인트 길이가 항상 480 이내(Play 500 안전마진)", () => {
  const long = Array.from({ length: 6 }, () => "- " + "가".repeat(300)).join("\n");
  const out = normalizeStoreNotes(long);
  const cpLen = [...out].length;
  assert.ok(cpLen <= STORE_NOTES_MAX_TOTAL, `cpLen=${cpLen}`);
});

test("이모지(서로게이트 페어) 포함 시 코드포인트 기준으로 480자 이내", () => {
  // 😀 는 UTF-16 유닛 2개이지만 코드포인트 1개. .length 기준이면 한도를 초과하는지 검증.
  const emojiLine = "😀".repeat(200);
  const out = normalizeStoreNotes(emojiLine);
  const cpLen = [...out].length;
  assert.ok(cpLen <= STORE_NOTES_MAX_TOTAL, `cpLen=${cpLen}`);
});

test("공백 없는 한글 장문도 하드 말줄임으로 길이 강제", () => {
  const out = normalizeStoreNotes("가".repeat(1000));
  assert.ok(out.length <= STORE_NOTES_MAX_TOTAL);
  assert.ok(out.endsWith("…"));
});

test("빈/공백 입력은 빈 문자열", () => {
  assert.equal(normalizeStoreNotes(""), "");
  assert.equal(normalizeStoreNotes("\n  \n---\n## 헤더만"), "");
});

test("buildReleaseNotesAsset: 비어있지 않은 언어만 포함", () => {
  const json = buildReleaseNotesAsset({ tag: "v1.2.3", koKR: "- 개선", enUS: "" });
  assert.ok(json);
  const parsed = JSON.parse(json!);
  assert.equal(parsed.schema, RELEASE_NOTES_ASSET_SCHEMA);
  assert.equal(parsed.version, "v1.2.3");
  assert.deepEqual(Object.keys(parsed.notes), ["ko-KR"]);
  assert.equal(parsed.notes["ko-KR"], "- 개선");
});

test("buildReleaseNotesAsset: 노트 없으면 null", () => {
  assert.equal(buildReleaseNotesAsset({ tag: "v1.0.0", koKR: "", enUS: "  " }), null);
});
