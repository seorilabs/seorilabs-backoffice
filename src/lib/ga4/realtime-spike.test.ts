import assert from "node:assert/strict";
import test from "node:test";
import { decideRealtimeSpike } from "@/lib/ga4/realtime-spike";

const start = Date.parse("2026-09-25T00:00:00Z");
const at = (n: number) => new Date(start + n * 300_000);

test("기준선이 부족하면 알리지 않고 10명·평소 3배를 두 번 연속 확인한다", () => {
  const missing = decideRealtimeSpike({ current: 30, history: Array(11).fill(2), bucketAt: at(0), previous: null });
  assert.equal(missing.alert, false);
  const first = decideRealtimeSpike({ current: 10, history: Array(12).fill(3), bucketAt: at(1), previous: missing.state });
  assert.equal(first.alert, false);
  const second = decideRealtimeSpike({ current: 10, history: Array(12).fill(3), bucketAt: at(2), previous: first.state });
  assert.equal(second.alert, true);
  assert.equal(second.baseline, 3);
  const held = decideRealtimeSpike({ current: 15, history: Array(12).fill(3), bucketAt: at(3), previous: second.state });
  assert.equal(held.alert, false);
});

test("표본 누락은 연속 고점을 끊고 저점 3회 뒤에만 재무장한다", () => {
  const history = Array(12).fill(2);
  const first = decideRealtimeSpike({ current: 10, history, bucketAt: at(0), previous: null });
  const gap = decideRealtimeSpike({ current: 10, history, bucketAt: at(2), previous: first.state });
  assert.equal(gap.alert, false);
  const alert = decideRealtimeSpike({ current: 10, history, bucketAt: at(3), previous: gap.state });
  assert.equal(alert.alert, true);
  const low1 = decideRealtimeSpike({ current: 2, history, bucketAt: at(4), previous: alert.state });
  const low2 = decideRealtimeSpike({ current: 2, history, bucketAt: at(5), previous: low1.state });
  assert.equal(low2.state.active, true);
  const low3 = decideRealtimeSpike({ current: 2, history, bucketAt: at(6), previous: low2.state });
  assert.equal(low3.state.active, false);
});
