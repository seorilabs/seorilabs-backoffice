import assert from "node:assert/strict";
import test from "node:test";
import { marketTabs, parseMarket, marketLabel } from "@/lib/analytics/market";
import type { AppContentSpec } from "@/lib/analytics/content-spec";

const MARKET_SPEC: AppContentSpec = {
  slug: "m",
  market: {
    param: "market",
    values: [
      { key: "apps-in-toss", label: "AppsInToss" },
      { key: "google-play", label: "Google Play" },
      { key: "app-store", label: "App Store" },
    ],
  },
  metrics: [{ key: "s", label: "시작", event: "game_start", agg: "count" }],
};

const NO_MARKET: AppContentSpec = { slug: "n", metrics: [{ key: "s", label: "s", event: "e", agg: "count" }] };

test("marketTabs: 통합 + 선언 순서", () => {
  assert.deepEqual(marketTabs(MARKET_SPEC).map((t) => t.key), ["all", "apps-in-toss", "google-play", "app-store"]);
  assert.deepEqual(marketTabs(NO_MARKET), []);
});

test("parseMarket: 유효 key 통과, 미지/공백/미선언은 all", () => {
  assert.equal(parseMarket(MARKET_SPEC, "google-play"), "google-play");
  assert.equal(parseMarket(MARKET_SPEC, "all"), "all");
  assert.equal(parseMarket(MARKET_SPEC, "bogus"), "all");
  assert.equal(parseMarket(MARKET_SPEC, undefined), "all");
  assert.equal(parseMarket(NO_MARKET, "google-play"), "all");
});

test("marketLabel: 통합/선언/미지", () => {
  assert.equal(marketLabel(MARKET_SPEC, "all"), "통합");
  assert.equal(marketLabel(MARKET_SPEC, "app-store"), "App Store");
  assert.equal(marketLabel(MARKET_SPEC, "weird"), "weird");
});
