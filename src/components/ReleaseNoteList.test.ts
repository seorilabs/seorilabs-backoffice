import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppLatestTable, AppVersionTable, MarketFilterTabs } from "./ReleaseNoteList";
import { groupNotesByVersion, type ReleaseNoteBodyLoader } from "@/lib/core/release-note-index";

const load: ReleaseNoteBodyLoader = async () => ({ ok: false, error: "미사용" });

const notes = [
  {
    id: "n-play",
    version: "v1.2.0",
    market: "PLAY" as const,
    previousVersion: "v1.1.0",
    compareUrl: null,
    createdAt: new Date("2026-09-10T02:00:00Z"),
  },
  {
    id: "n-appstore",
    version: "v1.2.0",
    market: "APPSTORE" as const,
    previousVersion: "v1.1.0",
    compareUrl: null,
    createdAt: new Date("2026-09-10T02:00:00Z"),
  },
];

test("앱 목록은 최신 버전과 마켓 버튼만 싣는다", () => {
  const [group] = groupNotesByVersion(notes);
  const html = renderToStaticMarkup(
    createElement(AppLatestTable, {
      load,
      rows: [{ appId: "app-1", appSlug: "happy-farm", appName: "해피팜", group }],
    }),
  );

  assert.ok(html.includes("해피팜"));
  assert.ok(html.includes("v1.2.0"));
  assert.ok(html.includes("← v1.1.0"));
  assert.ok(html.includes("Google Play"));
  assert.ok(html.includes("App Store"));
  // 1단계 화면은 앱 필터로 들어가는 링크를 준다.
  assert.ok(html.includes("/release-notes?app=happy-farm"));
});

test("태그 목록은 마켓 버튼을 태그당 한 줄로 묶는다", () => {
  const html = renderToStaticMarkup(
    createElement(AppVersionTable, {
      load,
      appName: "해피팜",
      groups: groupNotesByVersion([
        ...notes,
        {
          id: "n-old",
          version: "v1.1.0",
          market: "AIT" as const,
          previousVersion: null,
          compareUrl: null,
          createdAt: new Date("2026-08-01T02:00:00Z"),
        },
      ]),
    }),
  );

  const tbody = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  assert.equal((tbody.match(/<tr/g) ?? []).length, 2); // 태그 2줄 — 마켓 row 는 접힌다
  assert.ok(tbody.includes("v1.2.0") && tbody.includes("v1.1.0"));
  assert.ok(tbody.includes("AppsInToss"));
});

test("마켓 필터 탭은 보유 마켓만 건수와 함께 보여 준다", () => {
  const html = renderToStaticMarkup(
    createElement(MarketFilterTabs, {
      appSlug: "happy-farm",
      active: "PLAY" as const,
      total: 9,
      counts: [
        { key: "PLAY" as const, count: 4 },
        { key: "APPSTORE" as const, count: 5 },
      ],
    }),
  );

  assert.ok(html.includes("/release-notes?app=happy-farm&amp;market=PLAY"));
  assert.ok(html.includes("/release-notes?app=happy-farm&amp;market=APPSTORE"));
  assert.ok(!html.includes("market=AIT"));
  assert.ok(html.includes('aria-current="page"'));
});
