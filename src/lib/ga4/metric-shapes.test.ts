import assert from "node:assert/strict";
import test from "node:test";
import {
  pivotBreakdownRows,
  topN,
  platformDau,
  platformSegments,
  buildDayBreakdown,
  engagementRate,
  type Ga4BreakdownRow,
} from "@/lib/ga4/metric-shapes";

const rows: Ga4BreakdownRow[] = [
  { date: "2026-07-04", dim: "platform", val: "ANDROID", dau: 70 },
  { date: "2026-07-04", dim: "platform", val: "IOS", dau: 30 },
  { date: "2026-07-04", dim: "country", val: "KR", dau: 80 },
  { date: "2026-07-04", dim: "country", val: "US", dau: 20 },
  { date: "2026-07-04", dim: "device", val: "mobile", dau: 95 },
  { date: "2026-07-04", dim: "os", val: "Android 14", dau: 40 },
  { date: "2026-07-03", dim: "platform", val: "ANDROID", dau: 10 },
];

test("pivotBreakdownRows: date→dim→val→dau 로 피벗", () => {
  const p = pivotBreakdownRows(rows);
  assert.equal(p["2026-07-04"].platform.ANDROID, 70);
  assert.equal(p["2026-07-04"].country.KR, 80);
  assert.equal(p["2026-07-03"].platform.ANDROID, 10);
});

test("topN: dau 내림차순, 동률은 key 사전순, n 개로 절단", () => {
  const m = { KR: 80, US: 20, JP: 20 };
  assert.deepEqual(topN(m, 2), [
    { k: "KR", dau: 80 },
    { k: "JP", dau: 20 }, // 동률(20)에서 JP < US
  ]);
  assert.deepEqual(topN(undefined, 3), []);
});

test("platformDau: 대문자 ANDROID/IOS/WEB 매핑, 없으면 0", () => {
  assert.deepEqual(platformDau({ ANDROID: 70, IOS: 30 }), { android: 70, ios: 30, web: 0 });
  assert.deepEqual(platformDau(undefined), { android: 0, ios: 0, web: 0 });
});

test("buildDayBreakdown: 플랫폼 전용 컬럼 + raw top-N 구성", () => {
  const dims = pivotBreakdownRows(rows)["2026-07-04"];
  const bd = buildDayBreakdown(dims, 6);
  assert.equal(bd.dauAndroid, 70);
  assert.equal(bd.dauIos, 30);
  assert.equal(bd.dauWeb, 0);
  assert.deepEqual(bd.raw.countries, [
    { k: "KR", dau: 80 },
    { k: "US", dau: 20 },
  ]);
  assert.deepEqual(bd.raw.devices, [{ k: "mobile", dau: 95 }]);
  assert.deepEqual(bd.raw.osVersions, [{ k: "Android 14", dau: 40 }]);
});

test("buildDayBreakdown: 데이터 없는 날은 0/빈 배열", () => {
  const bd = buildDayBreakdown(undefined);
  assert.deepEqual(bd, {
    dauAndroid: 0,
    dauIos: 0,
    dauWeb: 0,
    raw: { countries: [], osVersions: [], devices: [] },
  });
});

test("platformSegments: 0 초과만 세그먼트, pct 정수, 총합", () => {
  const { segs, total } = platformSegments(70, 30, 0);
  assert.equal(total, 100);
  assert.deepEqual(
    segs.map((s) => [s.label, s.value, s.pct]),
    [
      ["Android", 70, 70],
      ["iOS", 30, 30],
    ],
  );
});

test("platformSegments: 전부 0 이면 total 0·빈 세그먼트(NaN width 진입 불가)", () => {
  const { segs, total } = platformSegments(0, 0, 0);
  assert.equal(total, 0);
  assert.deepEqual(segs, []);
});

test("engagementRate: engaged/dau %, dau 0 이면 null", () => {
  assert.equal(engagementRate(50, 100), 50);
  assert.equal(engagementRate(1, 3), 33.3); // 반올림 소수 1자리
  assert.equal(engagementRate(5, 0), null);
});
