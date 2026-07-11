import assert from "node:assert/strict";
import test from "node:test";
import {
  num,
  plantToHarvestRate,
  avgRevenuePerHarvest,
  unlockConversionRate,
} from "@/lib/ga4/content-shapes";
import { isContentMetricsApp, getContentMetricsApp } from "@/lib/ga4/content-apps";

test("num: 래핑값/문자열/비유한을 안전한 number 로", () => {
  assert.equal(num(42), 42);
  assert.equal(num("13"), 13);
  assert.equal(num({ value: "7" }), 7); // BigQuery numeric 래핑
  assert.equal(num(null), 0);
  assert.equal(num(undefined), 0);
  assert.equal(num("nope"), 0);
});

test("plantToHarvestRate: 수확/심기 %(소수1자리), 0분모는 null", () => {
  assert.equal(plantToHarvestRate(30, 50), 60);
  assert.equal(plantToHarvestRate(1, 3), 33.3);
  assert.equal(plantToHarvestRate(5, 0), null);
});

test("avgRevenuePerHarvest: 매출/수확, 0분모는 null", () => {
  assert.equal(avgRevenuePerHarvest(200, 8), 25);
  assert.equal(avgRevenuePerHarvest(100, 0), null);
});

test("unlockConversionRate: 언락/시도 %(소수1자리), 0분모는 null", () => {
  assert.equal(unlockConversionRate(3, 12), 25);
  assert.equal(unlockConversionRate(0, 0), null);
});

test("content-apps 레지스트리: happy-farm 만 대상, 미등록 앱은 제외", () => {
  assert.equal(isContentMetricsApp("happy-farm"), true);
  assert.equal(isContentMetricsApp("lucid-chess"), false);
  assert.equal(getContentMetricsApp("happy-farm")?.label, "행복한 농장");
  assert.equal(getContentMetricsApp("nope"), null);
});
