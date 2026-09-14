import assert from "node:assert/strict";
import test from "node:test";
import { resolveAsOf, type CoverageCell } from "@/lib/analytics/as-of";

const TODAY = "2026-09-14";
const YESTERDAY = "2026-09-13";

const targets = [
  { targetKey: "lizard-tycoon", weight: 107 },
  { targetKey: "crossword-puzzle", weight: 10 },
  { targetKey: "happy-farm", weight: 5 },
];

const cell = (
  targetKey: string,
  day: string,
  state: CoverageCell["state"],
  sealed = false,
): CoverageCell => ({ targetKey, day, state, sealed });

test("전 대상이 관측되고 봉인됐으면 확정", () => {
  const out = resolveAsOf({
    today: TODAY,
    targets,
    cells: targets.map((t) => cell(t.targetKey, YESTERDAY, "observed", true)),
  })!;
  assert.equal(out.day, YESTERDAY);
  assert.equal(out.verdict, "final");
  assert.equal(out.observed, 3);
  assert.equal(out.expected, 3);
  assert.equal(out.sealed, true);
  assert.deepEqual(out.missing, []);
});

test("전 대상 관측이어도 봉인 전이면 잠정", () => {
  const out = resolveAsOf({
    today: TODAY,
    targets,
    cells: targets.map((t) => cell(t.targetKey, YESTERDAY, "observed", false)),
  })!;
  assert.equal(out.verdict, "provisional");
  assert.equal(out.observed, out.expected);
  assert.equal(out.sealed, false);
});

test("활동 0 도 관측이다", () => {
  const out = resolveAsOf({
    today: TODAY,
    targets,
    cells: [
      cell("lizard-tycoon", YESTERDAY, "observed", true),
      cell("crossword-puzzle", YESTERDAY, "empty", true),
      cell("happy-farm", YESTERDAY, "empty", true),
    ],
  })!;
  assert.equal(out.verdict, "final");
  assert.equal(out.observed, 3);
});

test("빠진 대상의 무게를 드러낸다 — 09-13 실측 재현", () => {
  // 실제로 있었던 일: 도마뱀(DAU 107)만 빠졌는데 합계를 15 로 발행했다.
  const out = resolveAsOf({
    today: TODAY,
    targets,
    cells: [
      cell("lizard-tycoon", YESTERDAY, "not_landed"),
      cell("crossword-puzzle", YESTERDAY, "observed"),
      cell("happy-farm", YESTERDAY, "observed"),
    ],
  })!;
  assert.equal(out.verdict, "provisional");
  assert.equal(out.observed, 2);
  assert.equal(out.expected, 3);
  assert.deepEqual(out.missing, [
    { targetKey: "lizard-tycoon", state: "not_landed", weight: 107 },
  ]);
  // 3개 중 1개가 빠졌지만 무게로는 88% 다. 개수만 보면 이 차이를 놓친다.
  assert.ok(out.missingWeightShare > 0.87 && out.missingWeightShare < 0.89, String(out.missingWeightShare));
});

test("원장에 칸이 아예 없으면 unobserved 로 구분한다", () => {
  const out = resolveAsOf({ today: TODAY, targets, cells: [] })!;
  assert.equal(out.observed, 0);
  assert.equal(out.expected, 3);
  assert.deepEqual(out.missing.map((m) => m.state), ["unobserved", "unobserved", "unobserved"]);
  assert.equal(out.missingWeightShare, 1);
});

test("그 날 대상이 아니었던 칸은 분모를 늘리지 않는다", () => {
  const out = resolveAsOf({
    today: TODAY,
    targets,
    cells: [
      cell("lizard-tycoon", YESTERDAY, "observed", true),
      cell("crossword-puzzle", YESTERDAY, "observed", true),
      cell("happy-farm", YESTERDAY, "not_applicable"),
    ],
  })!;
  assert.equal(out.expected, 2);
  assert.equal(out.verdict, "final");
  assert.deepEqual(out.missing, []);
});

test("완전한 후보가 없으면 더 과거로 걸어 내려가지 않는다", () => {
  // 그저께는 완전하지만 lookback 이 1 이면 어제를 잠정으로 낸다.
  const out = resolveAsOf({
    today: TODAY,
    targets,
    cells: [
      ...targets.map((t) => cell(t.targetKey, "2026-09-12", "observed", true)),
      cell("lizard-tycoon", YESTERDAY, "not_landed"),
    ],
  })!;
  assert.equal(out.day, YESTERDAY);
  assert.equal(out.verdict, "provisional");
});

test("lookback 을 늘리면 완전한 최신 날로 내려간다", () => {
  const out = resolveAsOf({
    today: TODAY,
    targets,
    maxLookbackDays: 3,
    cells: [
      ...targets.map((t) => cell(t.targetKey, "2026-09-12", "observed", true)),
      cell("lizard-tycoon", YESTERDAY, "not_landed"),
    ],
  })!;
  assert.equal(out.day, "2026-09-12");
  assert.equal(out.verdict, "final");
});

test("requested 를 주면 그 날만 본다", () => {
  const out = resolveAsOf({
    today: TODAY,
    targets,
    requested: "2026-08-30",
    cells: [cell("crossword-puzzle", "2026-08-30", "observed", true)],
  })!;
  assert.equal(out.day, "2026-08-30");
  assert.equal(out.observed, 1);
  assert.equal(out.expected, 3);
});

test("대상이 없으면 null", () => {
  assert.equal(resolveAsOf({ today: TODAY, targets: [], cells: [] }), null);
});
