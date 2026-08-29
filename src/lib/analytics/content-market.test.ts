import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTENT_MARKETS,
  foldByContentMarket,
  isContentMarket,
  normalizeContentMarket,
} from "@/lib/analytics/content-market";

test("실측으로 확인된 표기 변형을 하나의 정규 키로 접는다", () => {
  // 2026-08-30 production 실측: crossword 하이픈, happy-farm 밑줄, foam·slot 플랫폼 어휘.
  for (const raw of ["apps-in-toss", "apps_in_toss", "AppsInToss", " ait ", "toss"]) {
    assert.equal(normalizeContentMarket(raw), "ait", raw);
  }
  for (const raw of ["google-play", "google_play", "GooglePlay", "play", "android"]) {
    assert.equal(normalizeContentMarket(raw), "play", raw);
  }
  for (const raw of ["app-store", "app_store", "AppStore", "appstore", "ios"]) {
    assert.equal(normalizeContentMarket(raw), "appstore", raw);
  }
  assert.equal(normalizeContentMarket("all"), "all");
});

test("web 은 AIT 서면인지 독립 웹인지 문자열만으로 알 수 없어 추측하지 않는다", () => {
  // 의도를 아는 쪽(스펙)이 정규 키를 선언한다. 여기서 ait 로 접으면 진짜 웹 서면이 섞인다.
  assert.equal(normalizeContentMarket("web"), "web");
});

test("모르는 표기는 버리지 않고 그대로 돌려준다", () => {
  // 조용히 삼키면 새 스펙의 오탈자가 드러나지 않는다.
  assert.equal(normalizeContentMarket("galaxy-store"), "galaxy-store");
  assert.equal(isContentMarket("galaxy-store"), false);
  for (const m of CONTENT_MARKETS) assert.equal(isContentMarket(m), true, m);
});

test("서로 다른 표기가 같은 키로 접히면 덮어쓰지 않고 충돌로 보고한다", () => {
  // 스냅샷은 합산 가능한 구조가 아니라 조용히 덮으면 하루치가 사라진다.
  const { folded, collisions } = foldByContentMarket([
    ["apps-in-toss", { a: 1 }],
    ["apps_in_toss", { a: 2 }],
    ["google_play", { a: 3 }],
  ]);
  assert.deepEqual(folded.map(([k]) => k), ["ait", "play"]);
  assert.equal(folded[0][1].a, 1, "먼저 온 값을 유지한다");
  assert.deepEqual(collisions, ["ait: apps-in-toss + apps_in_toss"]);
});

test("충돌이 없으면 값은 그대로 통과한다", () => {
  const { folded, collisions } = foldByContentMarket([
    ["all", 1],
    ["android", 2],
    ["ios", 3],
  ]);
  assert.deepEqual(folded, [["all", 1], ["play", 2], ["appstore", 3]]);
  assert.deepEqual(collisions, []);
});
