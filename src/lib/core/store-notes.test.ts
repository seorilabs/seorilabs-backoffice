import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStoreNotes,
  buildReleaseNotesAsset,
  buildGooglePlayReleaseNotesText,
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

test("buildReleaseNotesAsset v2: 마켓별로 분리하고 비어있지 않은 언어만 포함", () => {
  const json = buildReleaseNotesAsset({
    tag: "v1.2.3",
    markets: {
      googlePlay: {
        koKR: "- 개선",
        enUS: "",
        jaJP: "- 改善",
        zhCN: "- 改进",
        zhTW: "- 改善",
        deDE: "- Verbessert",
        frFR: "- Améliorations",
        esES: "- Mejoras",
      },
      appStore: {
        koKR: "- iOS 개선",
        enUS: "- iOS improvements",
        jaJP: "",
        zhCN: "",
        zhTW: "",
        deDE: "",
        frFR: "",
        esES: "",
      },
      appsInToss: {
        koKR: "- 토스 로그인 안내 제거",
        enUS: "- Removed toss login prompt",
      },
    },
  });
  assert.ok(json);
  const parsed = JSON.parse(json!);
  assert.equal(parsed.schema, "seorilabs.release-notes/v2");
  assert.equal(parsed.version, "v1.2.3");
  // 마켓별 본문
  assert.deepEqual(Object.keys(parsed.markets.googlePlay), [
    "ko-KR",
    "ja-JP",
    "zh-CN",
    "zh-TW",
    "de-DE",
    "fr-FR",
    "es-ES",
  ]);
  assert.equal(parsed.markets.googlePlay["ko-KR"], "- 개선");
  assert.equal(parsed.markets.googlePlay["ja-JP"], "- 改善");
  assert.deepEqual(Object.keys(parsed.markets.appStore), ["ko-KR", "en-US"]);
  assert.equal(parsed.markets.appStore["ko-KR"], "- iOS 개선");
  assert.deepEqual(Object.keys(parsed.markets.appsInToss), ["ko-KR", "en-US"]);
  // 레거시 notes 는 3 마켓 합집합 (중복 제거)
  assert.equal(parsed.notes["ko-KR"], "- 개선");
  assert.equal(parsed.notes["ja-JP"], "- 改善");
  assert.equal(parsed.notes["en-US"], "- iOS improvements");
});

test("buildReleaseNotesAsset: 마켓/언어 모두 비어있으면 null", () => {
  assert.equal(
    buildReleaseNotesAsset({
      tag: "v1.0.0",
      markets: { googlePlay: {}, appStore: {}, appsInToss: {} },
    }),
    null,
  );
});

test("Android용 출시노트를 Google Play 로케일 태그 형식으로 만든다", () => {
  assert.equal(
    buildGooglePlayReleaseNotesText({
      koKR: "- 개선",
      enUS: "- Improvements",
      jaJP: "- 改善",
      zhCN: "",
    }),
    [
      "<ko-KR>\n- 개선\n</ko-KR>",
      "<en-US>\n- Improvements\n</en-US>",
      "<ja-JP>\n- 改善\n</ja-JP>",
    ].join("\n"),
  );
});

test("Android용 출시노트는 번역이 없으면 빈 문자열이다", () => {
  assert.equal(buildGooglePlayReleaseNotesText({}), "");
});
