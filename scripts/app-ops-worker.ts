import { prisma } from "@/lib/prisma";
import {
  processNextAppOperation,
  recoverStaleAppOperations,
  redactExpiredAppOperations,
} from "@/lib/app-ops/worker";

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
  await recoverStaleAppOperations();
  let lastMaintenanceAt = 0;
  console.log("[app-ops-worker] 시작");

  while (!stopping) {
    const processed = await processNextAppOperation();
    const now = Date.now();
    if (now - lastMaintenanceAt >= 60_000) {
      await recoverStaleAppOperations(new Date(now));
      const redacted = await redactExpiredAppOperations(new Date(now));
      if (redacted > 0) {
        console.log(`[app-ops-worker] 만료 결과 ${redacted}건 제거`);
      }
      lastMaintenanceAt = now;
    }
    if (!processed) await sleep(pollIntervalMs);
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
