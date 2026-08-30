import { createFleetMigrationInventoryIssuer } from "@seorilabs/repo-contract/trusted-inventory-issuer";

import { createFleetMigrationGitHubAdapter } from "@/lib/control-plane/fleet-migration-github-adapter";
import {
  createFleetMigrationInventoryIssuerAdapters,
  createFleetMigrationMtlsSigningTransport,
  loadFleetMigrationInventoryPublicIdentity,
} from "@/lib/control-plane/fleet-migration-inventory-issuer-adapter";
import { createFleetMigrationOccurrenceStore } from "@/lib/control-plane/fleet-migration-occurrence";
import { getInstallationContext, readFleetGitHubAppPublicSource } from "@/lib/github/app";
import { prisma } from "@/lib/prisma";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`FLEET_MIGRATION_${name}_REQUIRED`);
  return value;
}

async function main(): Promise<void> {
  const occurrenceId = required("FLEET_MIGRATION_OCCURRENCE_ID");
  const runId = required("FLEET_MIGRATION_RUN_ID");
  const providerVectorDigest = required("FLEET_MIGRATION_PROVIDER_VECTOR_DIGEST");
  const context = await getInstallationContext({ forceRefresh: true });
  const github = createFleetMigrationGitHubAdapter({
    client: context.octokit,
    readAppSource: readFleetGitHubAppPublicSource,
    readRepositoryWebhookAcceptance: async () => {
      const row = await prisma.webhookDelivery.findFirst({
        where: { event: "repository" },
        orderBy: { receivedAt: "desc" },
        select: { deliveryId: true, receivedAt: true },
      });
      return row ? { deliveryId: row.deliveryId, acceptedAt: row.receivedAt } : null;
    },
  });
  const publicIdentity = await loadFleetMigrationInventoryPublicIdentity({
    publicKeyFile: required("FLEET_MIGRATION_INVENTORY_PUBLIC_KEY_FILE"),
    publicCatalogFile: required("FLEET_MIGRATION_INVENTORY_PUBLIC_CATALOG_FILE"),
  });
  const signing = createFleetMigrationInventoryIssuerAdapters({
    catalog: publicIdentity.catalog,
    signingTransport: createFleetMigrationMtlsSigningTransport({
      origin: required("FLEET_MIGRATION_SIGNING_SERVICE_ORIGIN"),
      caFile: required("FLEET_MIGRATION_SIGNING_SERVICE_CA_FILE"),
      certificateFile: required("FLEET_MIGRATION_SIGNING_SERVICE_CERT_FILE"),
      privateKeyFile: required("FLEET_MIGRATION_SIGNING_SERVICE_KEY_FILE"),
    }),
  });
  const occurrence = createFleetMigrationOccurrenceStore();
  const collection = await occurrence.read({ occurrenceId, runId, providerVectorDigest });
  const issuer = createFleetMigrationInventoryIssuer({
    inventoryPublicKey: publicIdentity.publicKey,
    clock: () => new Date(),
    readGitHubAppCapability: github.readGitHubAppCapability,
    readOccurrence: occurrence.read,
    readSigningKeyPublicIdentity: signing.readSigningKeyPublicIdentity,
    signInventoryPayload: signing.signInventoryPayload,
  });
  const issuance = await issuer.issueAuthoritative(collection);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    contract: issuance.contract,
    state: issuance.state,
    inventoryDigest: issuance.inventoryDigest,
    issuanceDigest: issuance.issuanceDigest,
    keyFingerprint: issuance.keyFingerprint,
    occurrenceId,
    runId,
    providerVectorDigest,
    privateKeyInput: false,
    secretValuesReturned: false,
  })}\n`);
}

main()
  .catch(() => {
    console.error("Fleet migration authoritative inventory 발급 실패: FLEET_MIGRATION_INVENTORY_ISSUANCE_FAILED");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
