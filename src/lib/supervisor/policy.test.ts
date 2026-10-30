import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibility,
  canReport,
  canDecide,
  dayKey,
  rankCandidates,
} from "./policy";
const now = new Date("2026-10-30T00:00:00Z");
const observation = {
  observedAt: new Date(now.getTime() - 1000),
  expiresAt: new Date(now.getTime() + 1000),
  waitUntil: null,
  samples: 10,
  minSamples: 5,
};
test("AC1 오래된 자료, 미래 시각, 표본 부족과 수정 후 대기를 제외한다", () => {
  assert.equal(eligibility(observation, now), null);
  assert.equal(
    eligibility({ ...observation, resolved: true }, now),
    "resolved",
  );
  assert.equal(eligibility({ ...observation, expiresAt: now }, now), "stale");
  assert.equal(
    eligibility(
      { ...observation, observedAt: new Date(now.getTime() + 60001) },
      now,
    ),
    "future",
  );
  assert.equal(eligibility({ ...observation, samples: 4 }, now), "samples");
  assert.equal(
    eligibility(
      { ...observation, waitUntil: new Date(now.getTime() + 1) },
      now,
    ),
    "waiting",
  );
});
test("AC1 같은 문제를 합치고 제외와 진행 중 문제를 게시하지 않는다", () => {
  const c = {
    targetId: "book",
    problemKey: "draft",
    impact: 3,
    confidence: 0.9,
    effortMinutes: 30,
    deadline: null,
  };
  assert.deepEqual(
    rankCandidates(
      [c, c, { ...c, problemKey: "excluded" }],
      new Set(["book:excluded"]),
      now,
    ),
    [c],
  );
  assert.deepEqual(rankCandidates([], new Set(), now), []);
});
test("AC2 같은 승인만 멱등 처리하고 오래된 버전, 해시와 만료 관측을 거부한다", () => {
  const p = { version: 2, digest: "a", status: "READY", snoozedUntil: null };
  assert.equal(canDecide(p, 2, "a", now), true);
  assert.equal(canDecide(p, 1, "a", now), false);
  assert.equal(canDecide(p, 2, "b", now), false);
  assert.equal(canDecide({ ...p, status: "SUPERSEDED" }, 2, "a", now), false);
  assert.equal(
    canDecide(
      { ...p, status: "SNOOZED", snoozedUntil: new Date(now.getTime() + 1) },
      2,
      "a",
      now,
    ),
    false,
  );
});
test("AC3 실행 소유자, 세대, lease, 취소를 확인한다", () => {
  const r = {
    executionLocation: "LOCAL",
    status: "PROCESSING",
    executionOwner: "pc",
    generation: 2,
    leaseUntil: new Date(now.getTime() + 1000),
  };
  assert.equal(canReport(r, "pc", 2, now), true);
  assert.equal(canReport(r, "other", 2, now), false);
  assert.equal(canReport(r, "pc", 1, now), false);
  assert.equal(canReport({ ...r, leaseUntil: now }, "pc", 2, now), false);
  assert.equal(canReport({ ...r, status: "CANCELLED" }, "pc", 2, now), false);
  assert.equal(
    canReport({ ...r, executionLocation: "SERVER" }, "pc", 2, now),
    false,
  );
});
test("AC1 한국 시간 기준 날짜를 사용한다", () =>
  assert.equal(dayKey(new Date("2026-10-29T15:00:00Z")), "2026-10-30"));
