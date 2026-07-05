import assert from "node:assert/strict";
import test from "node:test";
import { clampRetention } from "@/lib/core/analytics-collect";

const cohort = { d1Pct: 40, d3Pct: 20, d7Pct: 10 };

test("clampRetention: 코호트가 충분히 성숙하면 그대로 통과(age>=7)", () => {
  assert.deepEqual(clampRetention(cohort, 7), { d1Pct: 40, d3Pct: 20, d7Pct: 10 });
});

test("clampRetention: 아직 D7 미확정(age<7)이면 d7 만 null", () => {
  assert.deepEqual(clampRetention(cohort, 3), { d1Pct: 40, d3Pct: 20, d7Pct: null });
});

test("clampRetention: age=0(당일 코호트)이면 전부 null", () => {
  assert.deepEqual(clampRetention(cohort, 0), { d1Pct: null, d3Pct: null, d7Pct: null });
});

test("clampRetention: 코호트 데이터 없으면 전부 null", () => {
  assert.deepEqual(clampRetention(undefined, 30), {
    d1Pct: null,
    d3Pct: null,
    d7Pct: null,
  });
});
