import { reconcileDeploymentApprovals } from "@/lib/deployment-approvals/monitor";
import { recoverUncertainApprovals } from "@/lib/deployment-approvals/execute";
import { prisma } from "@/lib/prisma";
import { maintainOperatorCommands, processNextOperatorCommand } from "@/lib/operator/command-runs";

import { maintainMetricIssueRegistration } from "@/lib/metric-issues/worker";

const pollIntervalMs = Math.max(250, Number(process.env.OPERATOR_COMMAND_POLL_INTERVAL_MS ?? "1000"));
let stopping = false;
let registrationWork: Promise<void> | null = null;

function stop(): void {
  stopping = true;
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function monitorApprovals(): Promise<void> {
  while (!stopping) {
    await reconcileDeploymentApprovals();
    for (let elapsed = 0; elapsed < 60_000 && !stopping; elapsed += 1000) await sleep(1000);
  }
}

async function main(): Promise<void> {
  let lastMaintenance = 0;
  console.log("[operator-command-worker] 시작");
  while (!stopping) {
    if (Date.now() - lastMaintenance >= 60_000) {
      await recoverUncertainApprovals();
      await maintainOperatorCommands();
      if (!registrationWork) registrationWork = maintainMetricIssueRegistration()
        .catch(() => console.error("[operator-command-worker] 개선 이슈 등록 유지보수 실패"))
        .finally(() => { registrationWork = null; });
      lastMaintenance = Date.now();
    }
    const processed = await processNextOperatorCommand();
    if (!processed) await sleep(pollIntervalMs);
  }
  await registrationWork;
}

Promise.all([main(), monitorApprovals()])
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("[operator-command-worker] 실패:", error instanceof Error ? error.message : "error");
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
