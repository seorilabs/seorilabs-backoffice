import { prisma } from "@/lib/prisma";
import { maintainOperatorCommands, processNextOperatorCommand } from "@/lib/discord/command-runs";
import { registerDiscordGuildCommands } from "@/lib/discord/commands";

const pollIntervalMs = Math.max(250, Number(process.env.OPERATOR_COMMAND_POLL_INTERVAL_MS ?? "1000"));
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
  const registered = await registerDiscordGuildCommands();
  console.log(`[operator-command-worker] Discord 명령 ${registered.commands}개 등록`);
  let lastMaintenance = 0;
  console.log("[operator-command-worker] 시작");
  while (!stopping) {
    if (Date.now() - lastMaintenance >= 60_000) {
      await maintainOperatorCommands();
      lastMaintenance = Date.now();
    }
    const processed = await processNextOperatorCommand();
    if (!processed) await sleep(pollIntervalMs);
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("[operator-command-worker] 실패:", error instanceof Error ? error.message : "error");
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
