import { hostname } from "node:os";

import { prisma } from "@/lib/prisma";
import { runRepositoryDiscoveryOnce } from "@/lib/control-plane/repository-discovery-service";

const intervalText = process.env.REPOSITORY_DISCOVERY_POLL_INTERVAL_MS ?? "2000";
const intervalMs = Number(intervalText);
if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
  throw new Error("REPOSITORY_DISCOVERY_POLL_INTERVAL_MS_INVALID");
}
const configuredWorkerId = process.env.REPOSITORY_DISCOVERY_WORKER_ID?.trim();
const workerId = configuredWorkerId || `repository-discovery:${hostname()}`;

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  console.log(`[repository-discovery-worker] 시작 worker=${workerId}`);
  while (running) {
    try {
      const result = await runRepositoryDiscoveryOnce(workerId);
      if (result.claimed) {
        console.log(
          `[repository-discovery-worker] 완료 status=${result.status ?? "unknown"} reason=${result.reasonCode ?? "none"}`,
        );
        continue;
      }
    } catch {
      // Octokit 오류 객체에는 request header가 붙을 수 있어 원문을 출력하지 않는다.
      console.error("[repository-discovery-worker] 처리 실패 code=WORKER_ITERATION_FAILED");
    }
    await wait(intervalMs);
  }
}

main()
  .catch(() => {
    console.error("[repository-discovery-worker] 종료 code=WORKER_FATAL");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
