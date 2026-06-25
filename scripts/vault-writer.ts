// data ns CronJob 엔트리. PENDING 쓰기 요청을 PVC(읽기쓰기)의 allowlist 폴더에 기록.
// esbuild 단일 CJS 번들 → `node scripts-dist/vault-writer.cjs`.
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { drainVaultWrites } from "@/lib/vault/write-core";

function todayKST(): string {
  // KST(UTC+9) 기준 YYYY-MM-DD.
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

async function main() {
  const res = await drainVaultWrites({
    root: env.vaultPath(),
    allowedFolders: env.vaultWriteFolders(),
    datePrefix: todayKST(),
  });
  console.log("[vault-writer] result", JSON.stringify(res));
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("[vault-writer] 실패:", e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
