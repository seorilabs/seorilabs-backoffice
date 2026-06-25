// data ns CronJob 엔트리. Syncthing PVC(읽기전용)를 VAULT_PATH 로 받아 인덱싱.
// esbuild 로 단일 CJS 번들 → 런타임 이미지에 포함, `node scripts-dist/index-vault.cjs` 로 실행.
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { indexVaultCore } from "@/lib/vault/index-core";

async function main() {
  if (!env.minimaxConfigured()) {
    console.error("[index-vault] MiniMax 미구성(FEATURE_MINIMAX_ENABLED+키 필요). 중단.");
    process.exit(2);
  }
  const res = await indexVaultCore({
    root: env.vaultPath(),
    excludeDirs: env.vaultExcludeDirs(),
  });
  console.log("[index-vault] result", JSON.stringify(res));
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("[index-vault] 실패:", e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
