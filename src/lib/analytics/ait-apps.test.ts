import assert from "node:assert/strict";
import test from "node:test";
import {
  AIT_LISTINGS,
  AIT_MINIAPP_BY_SLUG,
  listingsForSlug,
  primaryListingForSlug,
} from "@/lib/analytics/ait-apps";

// AC-1: crossword-puzzle App(=repo)이 콘솔 리스팅 2개(웹 36555 + 네이티브 게임 56407)를
// 각각 별개 리스팅으로 보유한다(저장/조회 키가 miniAppId 로 분리되는 근거).
test("AC-1: crossword-puzzle 은 리스팅 2개(36555 웹 + 56407 게임)를 가진다", () => {
  const list = listingsForSlug("crossword-puzzle");
  const ids = list.map((l) => l.miniAppId).sort((a, b) => a - b);
  assert.deepEqual(ids, [36555, 56407]);
  // 같은 slug + 다른 miniAppId 로 분리 — 저장 유니크 키 (appId, miniAppId, date)의 근거.
  assert.equal(new Set(list.map((l) => l.appSlug)).size, 1);
  assert.equal(new Set(ids).size, 2);
});

// AC-3: 단일 리스팅 앱은 리스팅이 정확히 1개이며 그것이 primary — 기존 동작(1 App=1 리스팅)
// 하위호환의 근거. crossword-puzzle 외 모든 대상 slug 가 여기 해당한다.
test("AC-3: 단일 리스팅 앱은 리스팅 1개이고 primary(하위호환)", () => {
  const multi = new Set(["crossword-puzzle"]);
  const slugs = new Set(AIT_LISTINGS.map((l) => l.appSlug));
  for (const slug of slugs) {
    if (multi.has(slug)) continue;
    const list = listingsForSlug(slug);
    assert.equal(list.length, 1, `${slug} 는 단일 리스팅이어야 함`);
    assert.equal(list[0].primary, true, `${slug} 단일 리스팅은 primary`);
    // 하위호환 파생표 AIT_MINIAPP_BY_SLUG 가 그 리스팅을 가리킨다.
    assert.equal(AIT_MINIAPP_BY_SLUG[slug], list[0].miniAppId);
  }
});

// AC-4: App 당 단일값(개요/광고/커머스 카드)이 참조하는 primary 리스팅이 App 당 정확히 1개다.
// primaryListingForSlug 가 그 리스팅을 결정 — 리스팅 혼입 없이 스코프하는 근거.
test("AC-4: App 당 primary 리스팅은 정확히 1개", () => {
  const byApp = new Map<string, number>();
  for (const l of AIT_LISTINGS) {
    if (l.primary) byApp.set(l.appSlug, (byApp.get(l.appSlug) ?? 0) + 1);
  }
  for (const [slug, count] of byApp) {
    assert.equal(count, 1, `${slug} primary 리스팅은 1개여야 함`);
  }
  // 모든 대상 slug 에 primary 가 존재한다(단일값 조회가 항상 스코프를 얻음).
  for (const slug of new Set(AIT_LISTINGS.map((l) => l.appSlug))) {
    assert.ok(byApp.get(slug) === 1, `${slug} primary 누락`);
  }
});

// AC-4: crossword-puzzle 의 primary 는 네이티브 게임(56407) — 개요/광고/커머스 단일 카드가
// 이 miniAppId 로만 스코프해 웹(36555) 지표와 섞이지 않는다.
test("AC-4: crossword-puzzle primary 는 네이티브 게임 56407", () => {
  assert.equal(primaryListingForSlug("crossword-puzzle")?.miniAppId, 56407);
  assert.equal(AIT_MINIAPP_BY_SLUG["crossword-puzzle"], 56407);
});

// 무결성: miniAppId 는 리스팅 전역 유일(저장 유니크 키 전제).
test("miniAppId 는 전역 유일", () => {
  const ids = AIT_LISTINGS.map((l) => l.miniAppId);
  assert.equal(new Set(ids).size, ids.length);
});
