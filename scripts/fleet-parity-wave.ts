import { runFleetParityWave } from "@/lib/control-plane/fleet-parity-service";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name}가 필요합니다.`);
  return value;
}

async function main(): Promise<void> {
  const result = await runFleetParityWave({
    observedBy: required("FLEET_PARITY_PRINCIPAL"),
    idempotencyKey: required("FLEET_PARITY_OCCURRENCE_KEY"),
  });
  const wave = result.wave;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    waveId: wave.id,
    status: wave.status,
    scope: wave.scope,
    contractVersion: wave.contractVersion,
    cohortDigest: wave.cohortDigest,
    vectorDigest: wave.vectorDigest,
    evidenceDigest: wave.evidenceDigest,
    resultCount: wave.resultCount,
    matchCount: wave.matchCount,
    consecutiveMatchCount: wave.consecutiveMatchCount,
    cleanupAllowed: wave.cleanupAllowed,
    reasonCodes: [...new Set(wave.results.flatMap((item) => item.reasonCode ? [item.reasonCode] : []))].sort(),
  })}\n`);
  if (wave.status !== "PASSED") process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    const code = error instanceof ControlPlaneError
      ? error.code
      : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "FLEET_PARITY_INTERNAL_ERROR";
    console.error(`Fleet parity wave 실패: ${code}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
