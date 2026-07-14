import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReleaseNoteCard } from "./ReleaseNoteCard";

test("8개 언어 선택지를 렌더링하고 긴 출시노트를 줄이지 않는다", () => {
  const longKoNote = `- ${"긴 출시노트 본문 ".repeat(60).trim()}`;
  const html = renderToStaticMarkup(
    createElement(ReleaseNoteCard, {
      appName: "테스트 앱",
      appId: "app-1",
      version: "v1.2.3",
      previousVersion: "v1.2.2",
      createdAt: "2026-07-14",
      compareUrl: null,
      koKR: longKoNote,
      enUS: "- English note",
      jaJP: "- 日本語ノート",
      zhCN: "- 简体中文说明",
      zhTW: "- 繁體中文說明",
      deDE: "- Deutsche Hinweise",
      frFR: "- Notes en français",
      esES: "- Notas en español",
    }),
  );

  for (const label of [
    "한국어",
    "English",
    "日本語",
    "简体中文",
    "繁體中文",
    "Deutsch",
    "Français",
    "Español",
  ]) {
    assert.ok(html.includes(label), `${label} 선택지가 없습니다.`);
  }
  assert.ok(html.includes(longKoNote));
  assert.ok(!html.includes("…"));
  assert.ok(html.includes("Android용 전체 복사"));
});
