import { evaluateFleetMigrationShadowReadiness } from "@/lib/control-plane/fleet-migration-shadow-readiness";
import { prisma } from "@/lib/prisma";

function publicErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^FLEET_MIGRATION_SHADOW_[A-Z0-9_]+$/.test(message)
    ? message
    : /^REPOSITORY_BACKFILL_[A-Z0-9_]+$/.test(message)
      ? message
      : "FLEET_MIGRATION_SHADOW_INTERNAL_ERROR";
}

async function main(): Promise<void> {
  const result = await evaluateFleetMigrationShadowReadiness();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.state !== "READY") process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(`Fleet migration shadow readiness 실패: ${publicErrorCode(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
