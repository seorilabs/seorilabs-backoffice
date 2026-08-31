import { Prisma } from "@prisma/client";

import {
  createFleetMigrationBackofficeAdapter,
  stableFleetMigrationBackofficeStateDigest,
} from "@/lib/control-plane/fleet-migration-backoffice-adapter";
import {
  computeFleetMigrationFinalizationDigest,
  createFleetMigrationOccurrenceStore,
  type FleetMigrationFinalizationEvidence,
  type FleetMigrationOccurrenceCompleteRequest,
} from "@/lib/control-plane/fleet-migration-occurrence";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";

const ORGANIZATION_ID = "283115031";
const INSTALLATION_ID = "142120077";
const PAGE_CONTRACT = "seorilabs-github-installation-repositories-page-v1";
const HEAD_CONTRACT = "seorilabs-github-repository-head-readback-v1";

interface FinalizerGitHubAdapter {
  readInstallationRepositoriesPage(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  readRepositoryHead(request: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface RepositoryBinding {
  id: string;
  fullName: string;
  defaultRef: string;
  defaultBranch: string;
  sourceSha: string;
  treeSha: string;
  private: boolean;
  fork: boolean;
  blobInventoryDigest: string;
  detections: JsonValue[];
  initialBackofficeDigest: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function digest(value: JsonValue): string {
  return `sha256:${jsonDigest(value)}`;
}

function parseCollection(value: JsonValue): RepositoryBinding[] {
  const collection = value as Record<string, unknown>;
  const inventory = collection.inventory as Record<string, unknown> | null;
  const repositories = inventory?.repositories;
  const repositoryEvidence = (inventory?.collectionEvidence as Record<string, unknown> | null)?.repositoryEvidence;
  if (!Array.isArray(repositories) || !Array.isArray(repositoryEvidence)) {
    fail("FLEET_MIGRATION_FINALIZATION_COLLECTION_INVALID");
  }
  const evidenceById = new Map(repositoryEvidence.map((entry) => {
    const evidence = entry as Record<string, unknown>;
    return [String(evidence.repositoryId), evidence];
  }));
  const result = repositories.map((entry) => {
    const repositoryObservation = entry as Record<string, unknown>;
    const repository = repositoryObservation.repository as Record<string, unknown> | null;
    const id = String(repository?.id ?? "");
    const evidence = evidenceById.get(id);
    const backoffice = evidence?.backoffice as Record<string, unknown> | null;
    const defaultRef = String(repository?.defaultRef ?? "");
    if (
      !/^[1-9][0-9]{0,31}$/u.test(id)
      || !/^seorilabs\/[A-Za-z0-9._-]+$/u.test(String(repository?.fullName ?? ""))
      || !/^refs\/heads\/[A-Za-z0-9._/-]{1,128}$/u.test(defaultRef)
      || !/^[0-9a-f]{40}$/u.test(String(repository?.sourceSha ?? ""))
      || !/^[0-9a-f]{40}$/u.test(String(evidence?.treeSha ?? ""))
      || !/^sha256:[0-9a-f]{64}$/u.test(String(evidence?.blobInventoryDigest ?? ""))
      || repository?.archived !== false
      || typeof repository.private !== "boolean"
      || typeof repository.fork !== "boolean"
      || !Array.isArray(repositoryObservation.candidates)
      || !evidence
      || !backoffice
    ) fail("FLEET_MIGRATION_FINALIZATION_COLLECTION_INVALID");
    return {
      id,
      fullName: String(repository.fullName),
      defaultRef,
      defaultBranch: defaultRef.slice("refs/heads/".length),
      sourceSha: String(repository.sourceSha),
      treeSha: String(evidence.treeSha),
      private: repository.private,
      fork: repository.fork,
      blobInventoryDigest: String(evidence.blobInventoryDigest),
      detections: structuredClone(repositoryObservation.candidates) as JsonValue[],
      initialBackofficeDigest: stableFleetMigrationBackofficeStateDigest(backoffice),
    };
  });
  result.sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0);
  if (result.length < 1 || new Set(result.map(({ id }) => id)).size !== result.length) {
    fail("FLEET_MIGRATION_FINALIZATION_COLLECTION_INVALID");
  }
  return result;
}

async function readFinalGithubVector(
  github: FinalizerGitHubAdapter,
  expected: readonly RepositoryBinding[],
): Promise<string> {
  const repositories: Array<Record<string, JsonValue>> = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let terminalPage = false;
  // signed runtime cohort는 최대 500개이고 adapter page는 100개다. 한 페이지를
  // 더 허용해 숨은 extra repository를 감지하되 무한/반복 pagination은 거부한다.
  for (let page = 0; page < 6; page += 1) {
    const response = await github.readInstallationRepositoriesPage({
      contract: PAGE_CONTRACT,
      organizationId: ORGANIZATION_ID,
      organizationLogin: "seorilabs",
      installationId: INSTALLATION_ID,
      archived: false,
      pageSize: 100,
      cursor,
    });
    if (!Array.isArray(response.repositories)) fail("FLEET_MIGRATION_FINAL_GITHUB_INVALID");
    repositories.push(...response.repositories as Array<Record<string, JsonValue>>);
    if (repositories.length > expected.length) fail("FLEET_MIGRATION_FINAL_GITHUB_COHORT_DRIFT");
    if (response.hasNextPage === false && response.nextCursor === null) {
      terminalPage = true;
      break;
    }
    if (
      response.hasNextPage !== true
      || typeof response.nextCursor !== "string"
      || response.nextCursor.length < 1
      || seenCursors.has(response.nextCursor)
    ) {
      fail("FLEET_MIGRATION_FINAL_GITHUB_INVALID");
    }
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  if (!terminalPage) fail("FLEET_MIGRATION_FINAL_GITHUB_PAGINATION_INCOMPLETE");
  repositories.sort((left, right) => BigInt(String(left.id)) < BigInt(String(right.id)) ? -1 : 1);
  if (repositories.length !== expected.length) fail("FLEET_MIGRATION_FINAL_GITHUB_COHORT_DRIFT");
  const vector: Array<Record<string, JsonValue>> = [];
  for (let index = 0; index < expected.length; index += 1) {
    const binding = expected[index]!;
    const repository = repositories[index]!;
    if (
      repository.id !== binding.id
      || repository.fullName !== binding.fullName
      || repository.defaultBranch !== binding.defaultBranch
      || repository.archived !== false
      || repository.private !== binding.private
      || repository.fork !== binding.fork
    ) fail("FLEET_MIGRATION_FINAL_GITHUB_COHORT_DRIFT");
    const head = await github.readRepositoryHead({
      contract: HEAD_CONTRACT,
      organizationId: ORGANIZATION_ID,
      repositoryId: binding.id,
      fullName: binding.fullName,
      defaultRef: binding.defaultRef,
    });
    if (head.sourceSha !== binding.sourceSha || head.treeSha !== binding.treeSha) {
      fail("FLEET_MIGRATION_FINAL_GITHUB_SOURCE_DRIFT");
    }
    vector.push({
      id: binding.id,
      fullName: binding.fullName,
      defaultRef: binding.defaultRef,
      sourceSha: binding.sourceSha,
      treeSha: binding.treeSha,
      private: binding.private,
      fork: binding.fork,
    });
  }
  return digest({
    contract: "seorilabs-fleet-migration-final-github-vector-v1",
    organizationId: ORGANIZATION_ID,
    repositories: vector,
  });
}

export function createFleetMigrationFinalizer(input: {
  github: FinalizerGitHubAdapter;
  detectorSourceSha: string;
  readinessEvidenceDigest: string;
  readinessCohortDigest: string;
  snapshotSigningKeyId: string;
  snapshotPolicyRevision: string;
  approvedProofDigests: readonly string[];
  expectedRepositories: ReadonlyArray<{ id: string; fullName: string }>;
  assertRuntimeFresh: () => void;
  client?: typeof prisma;
}) {
  const client = input.client ?? prisma;
  return Object.freeze({
    async complete(request: Omit<FleetMigrationOccurrenceCompleteRequest, keyof FleetMigrationFinalizationEvidence>) {
      input.assertRuntimeFresh();
      const bindings = parseCollection(request.collection);
      const expectedCohort = [...input.expectedRepositories]
        .sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : 1);
      if (
        bindings.length !== expectedCohort.length
        || bindings.some((binding, index) => (
          binding.id !== expectedCohort[index]?.id
          || binding.fullName !== expectedCohort[index]?.fullName
        ))
      ) fail("FLEET_MIGRATION_FINAL_SIGNED_COHORT_MISMATCH");
      const finalGithubDigest = await readFinalGithubVector(input.github, bindings);
      input.assertRuntimeFresh();

      return client.$transaction(async (transaction) => {
        const backoffice = createFleetMigrationBackofficeAdapter({
          detectorSourceSha: input.detectorSourceSha,
          readinessEvidenceDigest: input.readinessEvidenceDigest,
          readinessCohortDigest: input.readinessCohortDigest,
          snapshotSigningKeyId: input.snapshotSigningKeyId,
          snapshotPolicyRevision: input.snapshotPolicyRevision,
          approvedProofDigests: input.approvedProofDigests,
          client: transaction as never,
        });
        const finalBackoffice: Array<{ repositoryId: string; digest: string }> = [];
        for (const binding of bindings) {
          const readback = await backoffice.readBackofficePublicEvidence({
            contract: "seorilabs-fleet-migration-backoffice-public-evidence-v1",
            organizationId: ORGANIZATION_ID,
            repositoryId: binding.id,
            fullName: binding.fullName,
            sourceRef: binding.defaultRef,
            sourceSha: binding.sourceSha,
            treeSha: binding.treeSha,
            blobInventoryDigest: binding.blobInventoryDigest,
            detections: binding.detections,
          });
          const currentDigest = stableFleetMigrationBackofficeStateDigest(readback.publicEvidence);
          if (currentDigest !== binding.initialBackofficeDigest) {
            fail("FLEET_MIGRATION_FINAL_BACKOFFICE_STATE_DRIFT");
          }
          finalBackoffice.push({ repositoryId: binding.id, digest: currentDigest });
        }
        const finalBackofficeDigest = digest({
          contract: "seorilabs-fleet-migration-final-backoffice-vector-v1",
          repositories: finalBackoffice,
        });
        // GitHub readback 뒤 시작한 Serializable BO snapshot이 길어져 capability가
        // 만료된 경우에도 terminal row를 남기지 않는다.
        input.assertRuntimeFresh();
        const finalizationDigest = computeFleetMigrationFinalizationDigest({
          ...request,
          finalGithubDigest,
          finalBackofficeDigest,
        });
        const occurrence = createFleetMigrationOccurrenceStore(transaction as never);
        return occurrence.complete({
          ...request,
          finalGithubDigest,
          finalBackofficeDigest,
          finalizationDigest,
        });
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 120_000,
      });
    },
  });
}
