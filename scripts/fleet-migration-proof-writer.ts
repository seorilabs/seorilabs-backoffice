import { createFleetMigrationProofWriter } from "@/lib/control-plane/fleet-migration-proof-writer";
import { readBoundSecretFile } from "@/lib/control-plane/seori-auth-agent-transport";
import { fleetMigrationPublicError } from "@/lib/control-plane/fleet-migration-public-error";
import { prisma } from "@/lib/prisma";

function required(name: string, pattern: RegExp): string {
  const value = process.env[name]?.trim() ?? "";
  if (!pattern.test(value)) throw new Error(`FLEET_MIGRATION_${name}_INVALID`);
  return value;
}

async function main(): Promise<void> {
  const requestRoot = required("PROOF_REQUEST_ROOT", /^\/[A-Za-z0-9._/-]{1,512}$/u);
  const requestFile = required("PROOF_REQUEST_FILE", /^[A-Za-z0-9._/-]{1,191}$/u);
  const publicKeyRoot = required("APPROVAL_PUBLIC_KEY_ROOT", /^\/[A-Za-z0-9._/-]{1,512}$/u);
  const publicKeyFile = required("APPROVAL_PUBLIC_KEY_FILE", /^[A-Za-z0-9._/-]{1,191}$/u);
  let requestBytes: Buffer | undefined;
  let publicKeyBytes: Buffer | undefined;
  try {
    requestBytes = await readBoundSecretFile({ root: requestRoot, relativePath: requestFile, allowGroupRead: true, maxBytes: 4 * 1024 * 1024 });
    publicKeyBytes = await readBoundSecretFile({ root: publicKeyRoot, relativePath: publicKeyFile, allowGroupRead: true, maxBytes: 64 * 1024 });
    const request = JSON.parse(requestBytes.toString("utf8")) as never;
    const writer = createFleetMigrationProofWriter({
      publicKey: publicKeyBytes,
      approvalKeyId: required("APPROVAL_KEY_ID", /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
      approvalKeyFingerprint: required("APPROVAL_KEY_FINGERPRINT", /^[0-9a-f]{64}$/u),
      approvalPolicyRevision: required("APPROVAL_POLICY_REVISION", /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
      snapshotSigningKeyId: required("SNAPSHOT_SIGNING_KEY_ID", /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
      snapshotPolicyRevision: required("SNAPSHOT_POLICY_REVISION", /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
    });
    const result = await writer.write(request);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      contract: "seorilabs-fleet-migration-proof-write-result-v1",
      state: result.state,
      proofDigest: result.proofDigest,
      secretValuesReturned: false,
    })}\n`);
  } finally {
    requestBytes?.fill(0);
    publicKeyBytes?.fill(0);
  }
}

main()
  .catch((error) => {
    // 종전에는 모든 실패를 code 하나로 삼켜 승인 만료인지, stable state 불일치인지,
    // idempotency 충돌인지 구분할 수 없었다. 같은 실행기 두 곳이 쓰는 공통 함수로
    // FLEET_MIGRATION_* 계열만 그대로 노출한다. 그 계열은 전수 조사에서 리터럴 상수와
    // sha256 hex, HTTP status만 담는 것이 확인돼 있다.
    console.error(`Fleet migration proof writer 실패: ${
      fleetMigrationPublicError(error, "FLEET_MIGRATION_PROOF_WRITE_FAILED")}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
