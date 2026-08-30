import {
  createFleetMigrationReadOnlyCollector,
  fleetMigrationCollectorContract,
} from "@seorilabs/repo-contract/fleet-migration-collector";
import { validateFleetMigrationLegacyDocument } from "@seorilabs/repo-contract/fleet-migration-legacy-validator";
import { fleetMigrationContract } from "@seorilabs/repo-contract/fleet-migration";

import { createFleetMigrationBackofficeAdapter } from "@/lib/control-plane/fleet-migration-backoffice-adapter";
import { createFleetMigrationFinalizer } from "@/lib/control-plane/fleet-migration-finalizer";
import { createFleetMigrationGitHubAdapter } from "@/lib/control-plane/fleet-migration-github-adapter";
import { createFleetMigrationOccurrenceStore } from "@/lib/control-plane/fleet-migration-occurrence";
import { loadFleetMigrationRuntimeCapability } from "@/lib/control-plane/fleet-migration-runtime-capability";
import {
  evaluateFleetMigrationShadowReadiness,
  readFleetMigrationBackoffice,
} from "@/lib/control-plane/fleet-migration-shadow-readiness";
import {
  listInstallationRepositorySeeds,
  readInstalledRepositoryVector,
} from "@/lib/control-plane/repository-discovery-backfill";
import { prisma } from "@/lib/prisma";

const SHA = /^[0-9a-f]{40}$/u;
const UID = /^[0-9a-f]{8}-[0-9a-f-]{27,63}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]{1,512}$/u;
const RELATIVE_PATH = /^[A-Za-z0-9._/-]{1,191}$/u;

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
  const executionId = environment("FLEET_MIGRATION_EXECUTION_ID", ID);
  const runtime = await loadFleetMigrationRuntimeCapability({
    attestationRoot: environment("FLEET_MIGRATION_RUNTIME_ATTESTATION_ROOT", ABSOLUTE_PATH),
    attestationFile: environment("FLEET_MIGRATION_RUNTIME_ATTESTATION_FILE", RELATIVE_PATH),
    publicKeyRoot: environment("FLEET_MIGRATION_RUNTIME_PUBLIC_KEY_ROOT", ABSOLUTE_PATH),
    publicKeyFile: environment("FLEET_MIGRATION_RUNTIME_PUBLIC_KEY_FILE", RELATIVE_PATH),
    tokenRoot: environment("FLEET_MIGRATION_GITHUB_TOKEN_ROOT", ABSOLUTE_PATH),
    tokenFile: environment("FLEET_MIGRATION_GITHUB_TOKEN_FILE", RELATIVE_PATH),
    expectedExecutionId: executionId,
    expectedBackofficeSourceSha: sourceSha,
    expectedDetectorSourceSha: detectorSourceSha,
    expectedKeyId: environment("FLEET_MIGRATION_RUNTIME_ATTESTATION_KEY_ID", ID),
    expectedKeyFingerprint: environment("FLEET_MIGRATION_RUNTIME_ATTESTATION_KEY_FINGERPRINT", /^[0-9a-f]{64}$/u),
    expectedPolicyRevision: environment("FLEET_MIGRATION_RUNTIME_ATTESTATION_POLICY_REVISION", ID),
  });
  await runtime.run(async (client) => {
    let readiness = await evaluateFleetMigrationShadowReadiness({
      getInstallationContext: async () => ({
        client,
        publicIdentity: {
          appId: runtime.payload.github.publicSource.installation.appId,
          installationId: runtime.payload.installationId,
          targetId: runtime.payload.organizationId,
          accountLogin: "seorilabs",
          targetType: "Organization",
          repositorySelection: "all",
          suspended: false,
        },
      }),
      listRepositories: (inventoryClient) => listInstallationRepositorySeeds(inventoryClient),
      readRepository: readInstalledRepositoryVector,
      readBackoffice: (repositoryIds) => readFleetMigrationBackoffice(repositoryIds),
      verifyConfigSnapshot: runtime.verifyConfigSnapshot,
      now: () => new Date(),
    });
    if (
      readiness.state !== "READY"
      || readiness.evidenceDigest !== runtime.payload.readinessEvidenceDigest
      || readiness.cohortDigest !== runtime.payload.readinessCohortDigest
    ) throw new Error("FLEET_MIGRATION_SHADOW_READINESS_BLOCKED");
    const readinessEvidenceDigest = readiness.evidenceDigest;
    const readinessCohortDigest = readiness.cohortDigest;
    const readinessRepositoryCount = readiness.activeRepositoryCount;
    readiness = null as never;
    (globalThis as { gc?: () => void }).gc?.();

    const github = createFleetMigrationGitHubAdapter({
      client,
      readAppSource: runtime.readAppSource,
      readRepositoryWebhookAcceptance: runtime.readRepositoryWebhookAcceptance,
    });
    const backoffice = createFleetMigrationBackofficeAdapter({
      detectorSourceSha,
      readinessEvidenceDigest,
      readinessCohortDigest,
      snapshotSigningKeyId: runtime.payload.snapshotSigningKeyId,
      snapshotPolicyRevision: runtime.payload.snapshotPolicyRevision,
      approvedProofDigests: runtime.payload.approvedProofDigests,
    });
    const occurrence = createFleetMigrationOccurrenceStore();
    const finalizer = createFleetMigrationFinalizer({
      github,
      detectorSourceSha,
      readinessEvidenceDigest,
      readinessCohortDigest,
      snapshotSigningKeyId: runtime.payload.snapshotSigningKeyId,
      snapshotPolicyRevision: runtime.payload.snapshotPolicyRevision,
      approvedProofDigests: runtime.payload.approvedProofDigests,
      expectedRepositories: runtime.payload.github.repositories,
      assertRuntimeFresh: runtime.assertFresh,
    });
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
      completeOccurrence: finalizer.complete,
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
      executionId,
      jobUid,
      podUid,
      occurrenceId: collection.occurrence.occurrenceId,
      runId: collection.occurrence.runId,
      providerVectorDigest: collection.occurrence.providerVectorDigest,
      inventoryDigest: collection.inventoryDigest,
      collectionDigest: collection.collectionDigest,
      readinessEvidenceDigest,
      readinessCohortDigest,
      runtimeAttestationDigest: runtime.publicAttestationDigest,
      readinessRepositoryCount,
      collectedRepositoryCount: inventory?.coverage?.observedRepositoryCount ?? null,
      githubMutations: 0,
      domainMutations: 0,
      occurrenceAuditWrites: 2,
      authoritative: false,
      readyForPlanning: false,
    })}\n`);
  });
}

main()
  .catch((error: unknown) => {
    console.error(`Fleet migration BOOTSTRAP shadow 실패: ${publicError(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
