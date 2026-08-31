import { createPrivateKey } from "node:crypto";

import { createFleetMigrationInventorySigningServer } from "@/lib/control-plane/fleet-migration-inventory-signing-service";
import { readBoundSecretFile } from "@/lib/control-plane/seori-auth-agent-transport";

const ROOT = "/var/run/seori-fleet-migration-inventory-signer";
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;

function required(name: string): string {
  const environmentName = `FLEET_MIGRATION_SIGNER_${name}`;
  const value = process.env[environmentName]?.trim();
  if (!value) throw new Error(`${environmentName}_REQUIRED`);
  return value;
}

async function main(): Promise<void> {
  const expectedKeyFingerprint = required("INVENTORY_KEY_FINGERPRINT");
  if (!FINGERPRINT.test(expectedKeyFingerprint)) {
    throw new Error("FLEET_MIGRATION_SIGNER_INVENTORY_KEY_FINGERPRINT_INVALID");
  }
  const port = Number(process.env.FLEET_MIGRATION_SIGNER_PORT ?? "9444");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("FLEET_MIGRATION_SIGNER_PORT_INVALID");
  }
  let clientCa: Buffer | undefined;
  let certificate: Buffer | undefined;
  let serverKey: Buffer | undefined;
  let signingKeyBytes: Buffer | undefined;
  let server: ReturnType<typeof createFleetMigrationInventorySigningServer> | undefined;
  try {
    clientCa = await readBoundSecretFile({ root: ROOT, relativePath: "server/client-ca.pem", allowGroupRead: true });
    certificate = await readBoundSecretFile({ root: ROOT, relativePath: "server/tls.crt", allowGroupRead: true });
    serverKey = await readBoundSecretFile({ root: ROOT, relativePath: "server/tls.key", allowGroupRead: true });
    signingKeyBytes = await readBoundSecretFile({ root: ROOT, relativePath: "signing/private-key.pem", allowGroupRead: true });
    const privateKey = createPrivateKey(signingKeyBytes);
    server = createFleetMigrationInventorySigningServer({
      tls: { ca: clientCa, cert: certificate, key: serverKey },
      privateKey,
      expectedKeyFingerprint,
    });
  } finally {
    clientCa?.fill(0);
    certificate?.fill(0);
    serverKey?.fill(0);
    signingKeyBytes?.fill(0);
  }
  if (!server) throw new Error("FLEET_MIGRATION_SIGNER_INITIALIZATION_FAILED");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stdout.write(`Fleet migration inventory signer ready: port=${port}\n`);
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch(() => {
  console.error("Fleet migration inventory signer 시작 실패: FLEET_MIGRATION_SIGNER_START_FAILED");
  process.exitCode = 1;
});
