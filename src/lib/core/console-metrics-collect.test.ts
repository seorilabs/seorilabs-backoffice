import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyRawSections,
  isConsoleMetricCollectionActive,
} from "@/lib/core/console-metrics-collect";

test("ACTIVE 앱만 신규 콘솔 지표 수집 대상이다", () => {
  assert.equal(isConsoleMetricCollectionActive("ACTIVE"), true);
  assert.equal(isConsoleMetricCollectionActive("PAUSED"), false);
  assert.equal(isConsoleMetricCollectionActive("DEPRECATED"), false);
});

test("raw 구조만 있고 값이 전부 비면 저장은 하되 경고로 드러낸다", () => {
  // producer 가 키만 만들고 값을 못 채우는 사고가 실제로 있었다
  // (2026-08-30: iaaByOs {IOS:null, ANDROID:null} 가 몇 달간 조용히 통과).
  assert.deepEqual(emptyRawSections({ iaaByOs: { IOS: null, ANDROID: null } }), ["iaaByOs"]);
  assert.deepEqual(emptyRawSections({ iaaByOs: { IOS: 120, ANDROID: null } }), []);
  assert.deepEqual(emptyRawSections({ referrer: [null, null] }), ["referrer"]);
});

test("값이 아예 없는 것과 값이 비어 온 것을 구분한다", () => {
  // 빈 배열·빈 객체는 "그날 데이터가 없음"이라 정상이다. 경고로 올리면 매일 울린다.
  assert.deepEqual(emptyRawSections({ referrer: [] }), []);
  assert.deepEqual(emptyRawSections({ iaaByOs: {} }), []);
  // 스칼라·null·비객체는 검사 대상이 아니다.
  assert.deepEqual(emptyRawSections({ total: 0, name: "x" }), []);
  assert.deepEqual(emptyRawSections(null), []);
  assert.deepEqual(emptyRawSections([1, 2]), []);
});

test("여러 구획이 동시에 비면 전부 보고한다", () => {
  assert.deepEqual(
    emptyRawSections({ iaaByOs: { IOS: null }, referrer: [null], iap: { total: 3 } }),
    ["iaaByOs", "referrer"],
  );
});
