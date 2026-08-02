export interface MaintenanceWatchdogClock {
  setInterval(
    handler: () => void,
    intervalMs: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface MaintenanceWatchdog {
  start(): void;
  runNow(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * processNextAppOperation이 remote I/O를 기다리는 동안에도 TTL cleanup을
 * 실행한다. 이전 tick이 끝나지 않았으면 같은 promise를 공유해 DB maintenance를
 * 중복 실행하지 않는다.
 */
export function createMaintenanceWatchdog(input: {
  intervalMs: number;
  run: () => Promise<void>;
  onError: (error: unknown) => void;
  clock?: MaintenanceWatchdogClock;
}): MaintenanceWatchdog {
  const clock = input.clock ?? { setInterval, clearInterval };
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  function launch(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    const tracked = Promise.resolve()
      .then(input.run)
      .finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
    inFlight = tracked;
    return tracked;
  }

  return {
    start() {
      if (stopped || timer !== null) return;
      timer = clock.setInterval(() => {
        void launch().catch(input.onError);
      }, input.intervalMs);
    },
    runNow: launch,
    async stop() {
      stopped = true;
      if (timer !== null) {
        clock.clearInterval(timer);
        timer = null;
      }
      // interval callback의 오류는 이미 onError로 전달됐다. graceful stop은
      // 진행 중 cleanup이 DB transaction을 끝낼 때까지만 기다린다.
      await inFlight?.catch(() => {});
    },
  };
}
