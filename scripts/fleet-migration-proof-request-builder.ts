/**
 * P7 proof write request builder — trusted approval service의 수집 단계다.
 *
 * `docs/FLEET_MIGRATION_SECURE_RUNTIME.md` §2는 저장소마다 5분 Ed25519
 * `PROOF_WRITE_APPROVAL`을 받아 proof snapshot 한 건을 INSERT하라고 정한다. 그 승인문은
 * repository inventory, detector SHA, readiness 두 digest, stable Backoffice state에
 * 결박되므로 지어낼 수 없고 실제 스캔 결과가 있어야 만든다.
 *
 * 이 스크립트는 그 스캔만 담당한다. collector를 proof 없는 의존성으로 배선해
 * 저장소별 request와 `stableBackofficeStateDigest`를 모아 stdout으로 낸다. 서명은 하지
 * 않는다 — 승인 private key는 클러스터에 두지 않고 trusted operator 로컬에만 둔다.
 *
 * 쓰기는 하나도 하지 않는다. occurrence claim/completion은 stub이고, 마지막 저장소까지
 * 수집한 뒤 sentinel로 collector를 중단시킨다.
 */
import {
  createFleetMigrationReadOnlyCollector,
  fleetMigrationCollectorContract,
} from "seorilabs-org-contracts/repo-contract/fleet-migration-collector";
import { fleetMigrationContract } from "seorilabs-org-contracts/repo-contract/fleet-migration";
import { validateFleetMigrationLegacyDocument } from "seorilabs-org-contracts/repo-contract/fleet-migration-legacy-validator";

import { createFleetMigrationBackofficeAdapter } from "@/lib/control-plane/fleet-migration-backoffice-adapter";
import { createFleetMigrationGitHubAdapter } from "@/lib/control-plane/fleet-migration-github-adapter";
import { fleetMigrationPublicError } from "@/lib/control-plane/fleet-migration-public-error";
import {
  evaluateFleetMigrationShadowReadiness,
  readFleetMigrationBackoffice,
} from "@/lib/control-plane/fleet-migration-shadow-readiness";
import {
  listInstallationRepositorySeeds,
  readInstalledRepositoryVector,
} from "@/lib/control-plane/repository-discovery-backfill";
import {
  getInstallationContext,
  readFleetGitHubAppPublicSource,
} from "@/lib/github/app";
import { prisma } from "@/lib/prisma";
import { verifySnapshot } from "@/lib/control-plane/json";

const SHA = /^[0-9a-f]{40}$/u;
const COLLECTED_ENOUGH = "FLEET_MIGRATION_PROOF_REQUEST_COLLECTION_COMPLETE";

type CollectedRequest = {
  contract: string;
  organizationId: string;
  repositoryId: string;
  fullName: string;
  sourceRef: string;
  sourceSha: string;
  treeSha: string;
  blobInventoryDigest: string;
  detections: unknown[];
};

function required(name: string, pattern: RegExp): string {
  const value = process.env[name]?.trim() ?? "";
  if (!pattern.test(value)) throw new Error(`FLEET_MIGRATION_${name}_INVALID`);
  return value;
}

/**
 * proof snapshot이 담을 candidate를 스캔 결과에서 만든다.
 *
 * `proofs`는 읽기 시점에 Backoffice adapter가 `sourceReadback`을 채우는 컨테이너다
 * (`fleet-migration-backoffice-adapter.ts:593-607`). 그래서 기록 시점에는 비어 있는
 * 것이 정확하다. 여기서 무언가를 채우면 하지 않은 대조를 했다고 기록하게 된다.
 */
function candidatesFromDetections(detections: readonly unknown[]): Record<string, unknown>[] {
  return detections.map((entry) => {
    const value = entry as { path?: unknown; contentDigest?: unknown; detection?: unknown };
    return {
      path: value.path,
      contentDigest: value.contentDigest,
      detection: value.detection,
      proofs: {},
    };
  });
}

async function main(): Promise<void> {
  const detectorSourceSha = required("FLEET_MIGRATION_DETECTOR_SOURCE_SHA", SHA);
  const snapshotSigningKey = process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY?.trim() ?? "";
  if (snapshotSigningKey.length < 1) {
    throw new Error("FLEET_MIGRATION_SNAPSHOT_SIGNING_KEY_INVALID");
  }

  const context = await getInstallationContext();
  const publicIdentity = {
    appId: context.publicState.appId,
    installationId: context.publicState.installationId,
    targetId: context.publicState.targetId,
    accountLogin: context.publicState.accountLogin,
    targetType: context.publicState.targetType,
    repositorySelection: context.publicState.repositorySelection,
    suspended: context.publicState.suspended,
  };

  // shadow와 같은 verifier를 써야 readiness digest가 같아진다. 진단 CLI의 기본값
  // (`() => false`)을 쓰면 모든 저장소가 ACTIVE_SNAPSHOT_INVALID가 되어 digest가 갈린다.
  const readiness = await evaluateFleetMigrationShadowReadiness({
    getInstallationContext: async () => ({ client: context.octokit, publicIdentity }),
    listRepositories: (client) => listInstallationRepositorySeeds(client),
    readRepository: readInstalledRepositoryVector,
    readBackoffice: (repositoryIds) => readFleetMigrationBackoffice(repositoryIds),
    verifyConfigSnapshot: ({ snapshot, digest, signature }) => verifySnapshot(
      snapshot,
      snapshotSigningKey,
      digest,
      signature,
    ),
    now: () => new Date(),
  });
  if (readiness.state !== "READY") {
    throw new Error("FLEET_MIGRATION_SHADOW_READINESS_BLOCKED");
  }

  const github = createFleetMigrationGitHubAdapter({
    client: context.octokit,
    readAppSource: readFleetGitHubAppPublicSource,
    readRepositoryWebhookAcceptance: async () => {
      const delivery = await prisma.webhookDelivery.findFirst({
        where: { event: "repository" },
        orderBy: { receivedAt: "desc" },
        select: { deliveryId: true, receivedAt: true },
      });
      return delivery
        ? { deliveryId: delivery.deliveryId, acceptedAt: delivery.receivedAt }
        : null;
    },
  });
  const backoffice = createFleetMigrationBackofficeAdapter({
    detectorSourceSha,
    readinessEvidenceDigest: readiness.evidenceDigest,
    readinessCohortDigest: readiness.cohortDigest,
    snapshotSigningKeyId: required("CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_ID", /^\S{1,191}$/u),
    snapshotPolicyRevision: required(
      "CONTROL_PLANE_SNAPSHOT_SIGNATURE_POLICY_REVISION",
      /^\S{1,191}$/u,
    ),
    approvedProofDigests: [],
  });

  const expected = new Set(readiness.repositories.map((repository) => repository.repoId));
  const collected: Array<Record<string, unknown>> = [];
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
    readBackofficePublicEvidence: async (request: Record<string, unknown>) => {
      const value = request as unknown as CollectedRequest;
      const { publicEvidence, stableBackofficeStateDigest } = await backoffice
        .readStableBackofficeState(request) as {
          publicEvidence: Record<string, unknown>;
          stableBackofficeStateDigest: string;
        };
      const candidates = candidatesFromDetections(value.detections);
      collected.push({
        repositoryId: value.repositoryId,
        repositoryFullName: value.fullName,
        sourceRef: value.sourceRef,
        sourceSha: value.sourceSha,
        treeSha: value.treeSha,
        blobInventoryDigest: value.blobInventoryDigest,
        detections: value.detections,
        candidates,
        stableBackofficeStateDigest,
      });
      return { publicEvidence, candidates };
    },
    // collector는 저장소 스캔을 모두 마친 뒤에 claim을 부른다. 수집이 목적이므로
    // 여기서 멈춘다. 계속 진행하면 shadow occurrence를 쓰게 되는데, 그건 proof가
    // 있어야 하는 별도 실행의 몫이다.
    claimOccurrence: () => {
      throw new Error(COLLECTED_ENOUGH);
    },
    completeOccurrence: () => {
      throw new Error("FLEET_MIGRATION_PROOF_REQUEST_BUILDER_MUST_NOT_WRITE");
    },
    readOccurrence: () => {
      throw new Error("FLEET_MIGRATION_PROOF_REQUEST_BUILDER_MUST_NOT_WRITE");
    },
  });

  try {
    await collector.collect({
      mode: "READ_ONLY_SHADOW",
      deliveryId: "fleet-proof-request-builder",
      requestedRunId: "fleet-proof-request-builder",
      inventoryId: "fleet-proof-request-builder",
      baselineRatification: fleetMigrationContract.initialBaseline.ratification,
    });
    throw new Error("FLEET_MIGRATION_PROOF_REQUEST_COLLECTION_INCOMPLETE");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== COLLECTED_ENOUGH) throw error;
  }

  // runtime capability issuer는 cohort 전체가 덮여야 통과한다
  // (`fleet-migration-runtime-proof-coverage.ts`). 여기서 같은 조건을 미리 강제해
  // 일부만 수집된 상태로 승인을 만들지 않는다.
  const covered = new Set(collected.map((item) => String(item.repositoryId)));
  if (
    covered.size !== collected.length
    || covered.size !== expected.size
    || [...expected].some((repoId) => !covered.has(repoId))
  ) {
    throw new Error("FLEET_MIGRATION_PROOF_REQUEST_COVERAGE_INVALID");
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    contract: "seorilabs-fleet-migration-proof-request-collection-v1",
    detectorSourceSha,
    readinessEvidenceDigest: readiness.evidenceDigest,
    readinessCohortDigest: readiness.cohortDigest,
    repositoryCount: collected.length,
    requests: collected,
    secretValuesReturned: false,
  })}\n`);
}

main()
  .catch((error: unknown) => {
    console.error(`Fleet migration proof request builder 실패: ${
      fleetMigrationPublicError(error, "FLEET_MIGRATION_PROOF_REQUEST_BUILD_FAILED")
    }`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
