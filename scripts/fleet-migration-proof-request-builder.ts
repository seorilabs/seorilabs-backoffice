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
import {
  computeFleetEvidenceDigest,
  fleetMigrationContract,
} from "seorilabs-org-contracts/repo-contract/fleet-migration";
import { validateFleetMigrationLegacyDocument } from "seorilabs-org-contracts/repo-contract/fleet-migration-legacy-validator";

import { createFleetMigrationBackofficeAdapter } from "@/lib/control-plane/fleet-migration-backoffice-adapter";
import { createFleetMigrationGitHubAdapter } from "@/lib/control-plane/fleet-migration-github-adapter";
import { fleetMigrationPublicError } from "@/lib/control-plane/fleet-migration-public-error";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
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
 * collector의 `bindCandidates`는 스캔한 detection 하나마다 candidate 하나를 요구하고
 * (`seen.size !== scannedByKey.size`면 거부), 그 candidate의 `sourceReadback`을 자신이
 * 방금 읽은 tree/blob과 대조한다. 즉 지어낼 수 없고 스캔 결과에서만 나온다.
 *
 * 나머지 proof 슬롯은 이 단계에서 하지 않은 대조다. 계약이 null을 허용하므로 null로 둔다.
 * 채우면 하지 않은 확인을 했다고 기록하게 된다.
 */
function candidatesFromDetections(input: {
  detections: readonly unknown[];
  repositoryId: string;
  fullName: string;
  sourceRef: string;
  sourceSha: string;
  treeSha: string;
  observedAt: string;
  subject: Record<string, unknown>;
}): Record<string, unknown>[] {
  return input.detections.map((entry) => {
    const scanned = entry as {
      path: string;
      gitEntry: Record<string, unknown>;
      contentDigest: string;
      detection: Record<string, unknown>;
    };
    const sourceReadback: Record<string, unknown> = {
      observationId: `github-source-readback-${input.repositoryId}-${
        jsonDigest({ path: scanned.path, contentDigest: scanned.contentDigest } as JsonValue).slice(0, 24)
      }`,
      observedAt: input.observedAt,
      repositoryId: input.repositoryId,
      sourceRef: input.sourceRef,
      sourceSha: input.sourceSha,
      treeSha: input.treeSha,
      path: scanned.path,
      gitEntry: structuredClone(scanned.gitEntry),
      contentDigest: scanned.contentDigest,
      state: "MATCH",
    };
    sourceReadback.evidenceDigest = computeFleetEvidenceDigest(sourceReadback);
    return {
      path: scanned.path,
      contentDigest: scanned.contentDigest,
      detection: structuredClone(scanned.detection),
      subject: structuredClone(input.subject),
      // 대체 대상은 이관 계획 단계에서 정한다. 수집 시점에 정해진 것이 없다.
      replacement: null,
      proofs: {
        activeConfigReadback: null,
        marketProfileReadback: null,
        workflowBundleReadback: null,
        platformFleetBindingReadback: null,
        sourceReadback,
        parityStream: null,
        buildOnly: [],
        credentialBindings: [],
        consumerReadback: null,
        rollback: {
          gitRestore: null,
          backofficeOutageRecovery: null,
          ownerGate: null,
        },
        controlPlaneReadback: null,
      },
    };
  });
}

/** candidate의 subject는 공개 증거에 이미 있는 사실만 옮긴다. */
function subjectFromEvidence(
  publicEvidence: Record<string, unknown>,
  request: CollectedRequest,
): Record<string, unknown> {
  const app = publicEvidence.app as { appId?: unknown } | null;
  const binding = publicEvidence.platformFleetBinding as { platformAppId?: unknown } | null;
  return {
    kind: publicEvidence.classification === "PRODUCT_APP" ? "PRODUCT_APP" : "REPOSITORY",
    appId: app?.appId ?? null,
    repositoryId: request.repositoryId,
    fullName: request.fullName,
    sourceRef: request.sourceRef,
    sourceSha: request.sourceSha,
    platformAppId: binding?.platformAppId ?? null,
    classificationDecisionRevision: publicEvidence.classificationDecisionRevision,
    classificationDecisionId: publicEvidence.classificationDecisionId,
  };
}

async function main(): Promise<void> {
  const detectorSourceSha = required("FLEET_MIGRATION_DETECTOR_SOURCE_SHA", SHA);
  // issuer(`fleet-migration-runtime-capability-issuer.ts:79-82`)와 **바이트 단위로 같은**
  // 키를 써야 verifier가 동치가 된다. trim하면 값에 개행이나 공백이 섞였을 때 issuer는
  // 유효하다고 보는 snapshot을 여기서만 ACTIVE_SNAPSHOT_INVALID로 판정해 수집이 막힌다.
  const snapshotSigningKey = process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "";
  if (snapshotSigningKey.length < 32 || snapshotSigningKey.length > 4096) {
    throw new Error("FLEET_MIGRATION_CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_INVALID");
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

  // issuer의 `resolveFleetMigrationApprovedProofDigests`는 ID뿐 아니라 full name과
  // source SHA까지 현재 readiness cohort와 대조한다. readiness 평가 뒤 스캔 사이에
  // HEAD가 움직이면 ID만 맞는 요청이 만들어지고, 그 승인은 전부 버려진다.
  const expectedVector = new Map(readiness.repositories.map((repository) => [
    repository.repoId,
    `${repository.repoFullName} ${repository.sourceSha ?? ""}`,
  ]));
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
    // 검증 실패는 collector가 단일 code로 감싸서 던지므로 어느 저장소의 어느 문서인지
    // 알 수 없다. 저장소 full name과 경로는 공개 식별자이니 실패 시 그것만 남긴다.
    // 문서 내용은 남기지 않는다.
    validateLegacyDocument: (request: Record<string, unknown>) => {
      try {
        return validateFleetMigrationLegacyDocument(request);
      } catch (error) {
        const code = error instanceof Error ? error.message : "UNKNOWN";
        console.error(`legacy document 검증 실패: repository=${
          String(request.fullName ?? "?")} path=${String(request.path ?? "?")} code=${code}`);
        throw error;
      }
    },
    readBackofficePublicEvidence: async (request: Record<string, unknown>) => {
      const value = request as unknown as CollectedRequest;
      // collector가 이 콜백의 예외를 단일 code로 감싸므로(`trustedReadback`) 어느 저장소에서
      // 무엇이 닫혔는지 알 수 없다. 저장소 full name과 실패 code는 공개 식별자이니 그것만
      // stderr에 남긴다. 증거 내용은 남기지 않는다. #355에서 legacy 검증에 쓴 것과 같다.
      const read = async () => {
        try {
          return await backoffice.readStableBackofficeState(request);
        } catch (error) {
          const code = error instanceof Error ? error.message : "UNKNOWN";
          console.error(`backoffice 증거 읽기 실패: repository=${
            String(request.fullName ?? "?")} sourceSha=${
            String(request.sourceSha ?? "?")} code=${code}`);
          throw error;
        }
      };
      const { publicEvidence, stableBackofficeStateDigest } = await read() as {
          publicEvidence: Record<string, unknown>;
          stableBackofficeStateDigest: string;
        };
      const candidates = candidatesFromDetections({
        detections: value.detections,
        repositoryId: value.repositoryId,
        fullName: value.fullName,
        sourceRef: value.sourceRef,
        sourceSha: value.sourceSha,
        treeSha: value.treeSha,
        observedAt: String(publicEvidence.observedAt),
        subject: subjectFromEvidence(publicEvidence, value),
      });
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

  // runtime capability issuer는 cohort 전체가 exact vector로 덮여야 통과한다
  // (`fleet-migration-runtime-proof-coverage.ts`). 여기서 같은 조건을 미리 강제해
  // 어긋난 상태로 승인을 만들지 않는다.
  const coveredVector = new Map(collected.map((item) => [
    String(item.repositoryId),
    `${String(item.repositoryFullName)} ${String(item.sourceSha)}`,
  ]));
  if (
    coveredVector.size !== collected.length
    || coveredVector.size !== expectedVector.size
    || [...expectedVector].some(([repoId, vector]) => coveredVector.get(repoId) !== vector)
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
