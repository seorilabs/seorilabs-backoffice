import { prisma } from "@/lib/prisma";
import {
  assertPlatformWorkerConfiguration,
  processNextAppOperation,
  recoverStaleAppOperations,
  redactExpiredAppOperations,
} from "@/lib/app-ops/worker";
import { env } from "@/lib/env";
import { createMaintenanceWatchdog } from "@/lib/app-ops/maintenance-watchdog";

const pollIntervalMs = Math.max(
  250,
  Number(process.env.APP_OPS_POLL_INTERVAL_MS ?? "1000"),
);
let stopping = false;

function stop(): void {
  stopping = true;
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  assertPlatformWorkerConfiguration({
    enabled: env.featurePlatformWrites(),
    writeConfigured: env.platformWriteConfigured(),
  });
  let maintenanceFailure: unknown = null;
  const maintenance = createMaintenanceWatchdog({
    intervalMs: 60_000,
    async run() {
      const now = new Date();
      await recoverStaleAppOperations(now);
      const redacted = await redactExpiredAppOperations(now);
      if (redacted > 0) {
        console.log(`[app-ops-worker] 만료 결과 ${redacted}건 제거`);
      }
    },
    onError(error) {
      maintenanceFailure = error;
      stopping = true;
    },
  });
  // 24시간 이상 중단 뒤 재기동해도 만료 row를 첫 작업으로 실행하지 않는다.
  await maintenance.runNow();
  maintenance.start();
  console.log("[app-ops-worker] 시작");

  try {
    while (!stopping) {
      const processed = await processNextAppOperation();
      if (maintenanceFailure) throw maintenanceFailure;
      if (!processed) await sleep(pollIntervalMs);
    }
    if (maintenanceFailure) throw maintenanceFailure;
  } finally {
    await maintenance.stop();
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(
      "[app-ops-worker] 실패:",
      error instanceof Error ? error.message : error,
    );
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
