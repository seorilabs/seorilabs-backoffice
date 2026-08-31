import assert from "node:assert/strict";
import test from "node:test";
import { niceMax, splitSegmentsOnNull } from "@/lib/report/chart-geometry";

test("축 최댓값은 읽기 좋은 눈금으로 올린다", () => {
  assert.equal(niceMax(0), 5);
  assert.equal(niceMax(5), 5);
  assert.equal(niceMax(6), 6);
  assert.equal(niceMax(73), 80);
  assert.equal(niceMax(101), 200);
  assert.equal(niceMax(1_000), 1_000);
});

const x = (i: number) => i * 10;
const y = (v: number) => 100 - v;

test("연속 구간은 하나의 path 로 이어진다", () => {
  const { paths, lonePoints } = splitSegmentsOnNull([10, 20, 30], x, y);
  assert.deepEqual(paths, ["M0,90 L10,80 L20,70"]);
  assert.deepEqual(lonePoints, []);
});

test("null(미수집)에서 선을 끊는다 — 없던 날을 이어 그리지 않는다", () => {
  const { paths } = splitSegmentsOnNull([10, 20, null, 30, 40], x, y);
  assert.deepEqual(paths, ["M0,90 L10,80", "M30,70 L40,60"]);
});

test("양옆이 결측인 고립 점은 마커 대상으로 분리한다", () => {
  const { paths, lonePoints } = splitSegmentsOnNull([null, 15, null, 30, 40], x, y);
  assert.deepEqual(paths, ["M30,70 L40,60"]);
  assert.deepEqual(lonePoints, [{ x: 10, y: 85 }]);
});

test("전부 결측이면 아무것도 그리지 않는다", () => {
  assert.deepEqual(splitSegmentsOnNull([null, null], x, y), { paths: [], lonePoints: [] });
  assert.deepEqual(splitSegmentsOnNull([], x, y), { paths: [], lonePoints: [] });
});
