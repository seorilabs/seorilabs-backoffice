import assert from "node:assert/strict";
import test from "node:test";
import { inferPropertyOffsetHours } from "@/lib/ga4/property-timezone";

const day = (date: string, firstUtc: string, lastUtc: string) => ({
  date,
  firstUtc: new Date(firstUtc),
  lastUtc: new Date(lastUtc),
});

test("KST property: event_date 경계가 전날 15:00 UTC 에 걸린다", () => {
  // 2026-09-12 KST = 2026-09-11T15:00Z ~ 2026-09-12T15:00Z
  const out = inferPropertyOffsetHours([
    day("2026-09-12", "2026-09-11T15:04:00Z", "2026-09-12T14:52:00Z"),
    day("2026-09-13", "2026-09-12T15:10:00Z", "2026-09-13T14:30:00Z"),
  ])!;
  assert.equal(out.contradictory, false);
  assert.equal(out.matchesKst, true);
  assert.equal(out.excludesUtc, true);
  // 첫 이벤트가 로컬 자정 4분 뒤 → 오프셋 상한 9h + 4분 이내로 조인다.
  assert.ok(out.minOffsetHours <= 9 && out.maxOffsetHours >= 9, JSON.stringify(out));
});

test("UTC property 는 KST 와 구분된다", () => {
  const out = inferPropertyOffsetHours([
    day("2026-09-12", "2026-09-12T00:03:00Z", "2026-09-12T23:41:00Z"),
  ])!;
  assert.equal(out.matchesKst, false);
  assert.equal(out.excludesUtc, false);
});

test("트래픽이 적어 범위가 넓으면 단정하지 않는다", () => {
  // 하루에 이벤트가 한 번, 그것도 로컬 정오 무렵이면 오프셋 범위가 크게 남는다.
  const out = inferPropertyOffsetHours([
    day("2026-09-12", "2026-09-12T03:00:00Z", "2026-09-12T03:00:00Z"),
  ])!;
  assert.equal(out.contradictory, false);
  assert.equal(out.matchesKst, true); // 모순되지 않을 뿐이다
  assert.equal(out.excludesUtc, false); // UTC 도 여전히 가능 → 단정 불가
});

test("기기 시계 이상으로 관측이 서로 모순되면 드러낸다", () => {
  const out = inferPropertyOffsetHours([
    day("2026-09-12", "2026-09-11T15:00:00Z", "2026-09-12T14:00:00Z"),
    day("2026-09-13", "2026-09-13T00:00:00Z", "2026-09-13T23:00:00Z"),
  ])!;
  assert.equal(out.contradictory, true);
  assert.equal(out.matchesKst, false);
});

test("관측이 없으면 null", () => {
  assert.equal(inferPropertyOffsetHours([]), null);
});
