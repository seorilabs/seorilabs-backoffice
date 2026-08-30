import {
  createFleetMigrationReadOnlyCollector,
  fleetMigrationCollectorContract,
} from "@seorilabs/repo-contract/fleet-migration-collector";
import { validateFleetMigrationLegacyDocument } from "@seorilabs/repo-contract/fleet-migration-legacy-validator";
import { fleetMigrationContract } from "@seorilabs/repo-contract/fleet-migration";

import { createFleetMigrationBackofficeAdapter } from "@/lib/control-plane/fleet-migration-backoffice-adapter";
import { createFleetMigrationGitHubAdapter } from "@/lib/control-plane/fleet-migration-github-adapter";
import { createFleetMigrationOccurrenceStore } from "@/lib/control-plane/fleet-migration-occurrence";
import { evaluateFleetMigrationShadowReadiness } from "@/lib/control-plane/fleet-migration-shadow-readiness";
import { assertFullOrganizationInstallation } from "@/lib/control-plane/repository-discovery-backfill";
import { getInstallationContext, readFleetGitHubAppPublicSource } from "@/lib/github/app";
import { prisma } from "@/lib/prisma";

const SHA = /^[0-9a-f]{40}$/u;
const UID = /^[0-9a-f]{8}-[0-9a-f-]{27,63}$/u;

function environment(name: string, pattern: RegExp): string {
  const value = process.env[name]?.trim() ?? "";
  if (!pattern.test(value)) throw new Error(`FLEET_MIGRATION_${name}_INVALID`);
  return value;
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^FLEET_MIGRATION_[A-Z0-9_:,-]+$/u.test(message)
    ? message
    : /^REPOSITORY_BACKFILL_[A-Z0-9_]+$/u.test(message)
      ? message
      : "FLEET_MIGRATION_BOOTSTRAP_SHADOW_FAILED";
}

async function main(): Promise<void> {
  const sourceSha = environment("BACKOFFICE_SOURCE_SHA", SHA);
  const detectorSourceSha = environment("FLEET_MIGRATION_DETECTOR_SOURCE_SHA", SHA);
  const jobUid = environment("FLEET_MIGRATION_JOB_UID", UID);
  const podUid = environment("FLEET_MIGRATION_POD_UID", UID);
  const snapshotSigningKeyId = environment(
    "CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_ID",
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u,
  );
  const snapshotPolicyRevision = environment(
    "CONTROL_PLANE_SNAPSHOT_SIGNATURE_POLICY_REVISION",
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u,
  );
  let readiness = await evaluateFleetMigrationShadowReadiness();
  if (readiness.state !== "READY") throw new Error("FLEET_MIGRATION_SHADOW_READINESS_BLOCKED");
  const readinessEvidenceDigest = readiness.evidenceDigest;
  const readinessCohortDigest = readiness.cohortDigest;
  const readinessRepositoryCount = readiness.activeRepositoryCount;
  readiness = null as never;
  (globalThis as { gc?: () => void }).gc?.();

  const context = await getInstallationContext({ forceRefresh: true });
  assertFullOrganizationInstallation(context, "seorilabs");
  if (
    context.publicState.installationId !== fleetMigrationCollectorContract.githubApp.installationId
    || context.publicState.suspended
  ) throw new Error("FLEET_MIGRATION_GITHUB_APP_CAPABILITY_UNVERIFIED");
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
  const backoffice = createFleetMigrationBackofficeAdapter({
    detectorSourceSha,
    readinessEvidenceDigest,
    snapshotSigningKeyId,
    snapshotPolicyRevision,
  });
  const occurrence = createFleetMigrationOccurrenceStore();
  const collector = createFleetMigrationReadOnlyCollector({
    organizationId: fleetMigrationCollectorContract.organizationId,
    installationId: fleetMigrationCollectorContract.githubApp.installationId,
    detectorRepositoryId: fleetMigrationCollectorContract.detectorSource.repositoryId,
    detectorSourceSha,
    pageSize: 100,
    clock: () => new Date(),
    readGitHubAppCapability: github.readGitHubAppCapability,
    readInstallationRepositoriesPage: github.readInstallationRepositoriesPage,
    readRepositoryHead: github.readRepositoryHead,
    readRepositoryTree: github.readRepositoryTree,
    readBlob: github.readBlob,
    validateLegacyDocument: validateFleetMigrationLegacyDocument,
    readBackofficePublicEvidence: backoffice.readBackofficePublicEvidence,
    claimOccurrence: occurrence.claim,
    completeOccurrence: occurrence.complete,
    readOccurrence: occurrence.read,
  });
  const collection = await collector.collect({
    mode: "READ_ONLY_SHADOW",
    deliveryId: `fleet-job-${jobUid}`,
    requestedRunId: `fleet-pod-${podUid}`,
    inventoryId: `fleet-bootstrap-${jobUid}`,
    baselineRatification: fleetMigrationContract.initialBaseline.ratification,
  });
  const inventory = collection.inventory as { coverage?: { observedRepositoryCount?: unknown } } | undefined;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    contract: "fleet-migration-bootstrap-shadow-production/v1",
    state: collection.state,
    sourceSha,
    detectorSourceSha,
    jobUid,
    podUid,
    occurrenceId: collection.occurrence.occurrenceId,
    runId: collection.occurrence.runId,
    providerVectorDigest: collection.occurrence.providerVectorDigest,
    inventoryDigest: collection.inventoryDigest,
    collectionDigest: collection.collectionDigest,
    readinessEvidenceDigest,
    readinessCohortDigest,
    readinessRepositoryCount,
    collectedRepositoryCount: inventory?.coverage?.observedRepositoryCount ?? null,
    githubMutations: 0,
    domainMutations: 0,
    occurrenceAuditWrites: 1,
    authoritative: false,
    readyForPlanning: false,
  })}\n`);
}

main()
  .catch((error: unknown) => {
    console.error(`Fleet migration BOOTSTRAP shadow 실패: ${publicError(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
