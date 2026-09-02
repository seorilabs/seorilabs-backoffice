import { createFleetMigrationAuthoritativeIssuanceStore } from "@/lib/control-plane/fleet-migration-authoritative-issuance";
import { createFleetP7GitHubReadbackAdapter } from "@/lib/control-plane/fleet-p7-github-readback";
import { createFleetP7TrustedAggregateReadback } from "@/lib/control-plane/fleet-p7-trusted-readback";
import { loadFleetMigrationInventoryPublicIdentity } from "@/lib/control-plane/fleet-migration-inventory-issuer-adapter";
import { createFleetP7RequestFetch, createFleetP7ScopedReadClient } from "@/lib/control-plane/fleet-p7-scoped-read-client";
import { getFleetScopedGithubTokenIssuer, readFleetGitHubAppPublicSource } from "@/lib/github/app";
import { prisma } from "@/lib/prisma";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`FLEET_P7_${name}_REQUIRED`);
  return value;
}

async function main(): Promise<void> {
  const occurrenceId = required("OCCURRENCE_ID");
  const runId = required("RUN_ID");
  const providerVectorDigest = required("PROVIDER_VECTOR_DIGEST");
  const issuanceDigest = required("ISSUANCE_DIGEST");
  const publicIdentity = await loadFleetMigrationInventoryPublicIdentity({
    root: required("INVENTORY_PUBLIC_ROOT"),
    publicKeyFile: required("INVENTORY_PUBLIC_KEY_FILE"),
    publicCatalogFile: required("INVENTORY_PUBLIC_CATALOG_FILE"),
  });
  const now = new Date();
  const issuance = await createFleetMigrationAuthoritativeIssuanceStore().readExact({
    occurrenceId,
    runId,
    providerVectorDigest,
    issuanceDigest,
    publicKey: publicIdentity.publicKey,
    now,
  });
  const requestFetch = createFleetP7RequestFetch();
  const client = createFleetP7ScopedReadClient(await getFleetScopedGithubTokenIssuer({ requestFetch }));
  const github = createFleetP7GitHubReadbackAdapter({
    client,
    readAppSource: () => readFleetGitHubAppPublicSource({ requestFetch }),
  });
  const aggregate = await createFleetP7TrustedAggregateReadback({
    issuance,
    publicKey: publicIdentity.publicKey,
    now,
    readGitHub: github.read,
  });
  process.stdout.write(`${JSON.stringify(aggregate)}\n`);
}

main()
  .catch(() => {
    console.error("Fleet P7 trusted readback 실패: FLEET_P7_TRUSTED_READBACK_FAILED");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
