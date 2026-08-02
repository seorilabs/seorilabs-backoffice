import assert from "node:assert/strict";
import test from "node:test";

import {
  createMaintenanceWatchdog,
  type MaintenanceWatchdogClock,
} from "./maintenance-watchdog";

test("remote process await와 독립적으로 tick하고 maintenance는 single-flight다", async () => {
  let tick: (() => void) | undefined;
  let cleared = false;
  const clock: MaintenanceWatchdogClock = {
    setInterval(handler) {
      tick = handler as () => void;
      return { fake: true } as never;
    },
    clearInterval() {
      cleared = true;
    },
  };
  let finishFirst: (() => void) | undefined;
  let calls = 0;
  const watchdog = createMaintenanceWatchdog({
    intervalMs: 60_000,
    clock,
    onError(error) {
      throw error;
    },
    async run() {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
    },
  });

  // processNextAppOperation이 아직 반환하지 않은 상황을 나타내는 미완료 promise.
  void new Promise<void>(() => {});
  watchdog.start();
  tick?.();
  tick?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  finishFirst?.();
  await new Promise((resolve) => setImmediate(resolve));
  tick?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);

  await watchdog.stop();
  assert.equal(cleared, true);
});

test("graceful stop은 timer를 지우고 진행 중 maintenance 완료를 기다린다", async () => {
  let finish: (() => void) | undefined;
  let tick: (() => void) | undefined;
  const clock: MaintenanceWatchdogClock = {
    setInterval(handler) {
      tick = handler as () => void;
      return { fake: true } as never;
    },
    clearInterval() {},
  };
  const watchdog = createMaintenanceWatchdog({
    intervalMs: 60_000,
    clock,
    onError() {},
    run: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  watchdog.start();
  tick?.();
  await new Promise((resolve) => setImmediate(resolve));

  let stopped = false;
  const stopping = watchdog.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finish?.();
  await stopping;
  assert.equal(stopped, true);
});
