// data ns 고정 실행기. Deployment Recreate + replicas 1로 한 번에 한 인덱싱만 실행한다.
import { setTimeout as delay } from "node:timers/promises";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { indexVaultCore } from "@/lib/vault/index-core";
import { runVaultIndexTick } from "@/lib/vault/index-worker";

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function main() {
  if (!env.geminiConfigured()) throw new Error("VAULT_EMBEDDING_UNCONFIGURED");
  while (!stopping) {
    try {
      await runVaultIndexTick({
        now: new Date(),
        index: async () => {
          // 기존 CronJob의 3000초 실행 한도를 유지한다. 중단 시 checkpoint를 쓰지 않는다.
          const deadline = setTimeout(() => process.exit(1), 3_000_000);
          try {
            const result = await indexVaultCore({ root: env.vaultPath(), includeDirs: env.vaultIncludeDirs(), excludeDirs: env.vaultExcludeDirs() });
            console.log("[index-vault] result", JSON.stringify(result));
          } finally { clearTimeout(deadline); }
        },
      });
    } catch {
      console.error("[index-vault] 요청 처리 실패 — 완료 기록 없이 재시도합니다.");
    }
    if (!stopping) await delay(15_000);
  }
}
main().catch(() => { console.error("[index-vault] 설정 오류로 중단합니다."); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
