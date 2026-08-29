import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { Octokit } from "@/lib/github/app";
import {
  claimRepositoryDiscoveryRun,
  processRepositoryDiscoveryClaim,
  recoverRepositoryDiscoveryRuns,
} from "@/lib/control-plane/repository-discovery-service";
import {
  getRepositoryClassificationQueue,
  recordRepositoryClassificationDecision,
} from "@/lib/control-plane/repository-classification-decision";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { REPOSITORY_REGISTRATION_SLO_MS } from "@/lib/control-plane/repository-discovery";
import { registerRepositoryWebhook } from "@/lib/control-plane/repository-registration";
import { prisma } from "@/lib/prisma";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL이 필요합니다.");

const RN_REPO_ID = 8_900_000_001;
const DRIFT_REPO_ID = 8_900_000_002;
const PLATFORM_REPO_ID = 8_900_000_003;
const ADOPTION_REPO_ID = 8_900_000_004;
const CLASSIFICATION_REPO_ID = 8_900_000_005;
const SOURCE_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const CANARY = "repository-discovery-secret-canary";

type FakeRepository = {
  repoId: number;
  fullName: string;
  headSha: string;
  files: Record<string, string>;
};

function fakeOctokit(input: FakeRepository): Octokit {
  const name = input.fullName.split("/")[1];
  return {
    rest: {
      repos: {
        async get() {
          return { data: {
            id: input.repoId,
            full_name: input.fullName,
            name,
            default_branch: "main",
            private: true,
            fork: false,
            archived: false,
          } };
        },
        async getCommit(args: { ref: string }) {
          if (args.ref !== "main" && args.ref !== input.headSha) {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
          return { data: { sha: input.headSha, commit: { tree: { sha: TREE_SHA } } } };
        },
        async getContent(args: { path: string; ref: string }) {
          if (args.ref !== input.headSha || !(args.path in input.files)) {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
          const text = input.files[args.path];
          return { data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(text).toString("base64"),
            sha: createHash("sha1").update(`${args.path}:${text}`).digest("hex"),
            size: Buffer.byteLength(text),
          } };
        },
      },
      git: {
        async getTree() {
          return { data: {
            sha: TREE_SHA,
            truncated: false,
            tree: Object.keys(input.files).map((path) => ({ path, type: "blob" })),
          } };
        },
      },
    },
  } as unknown as Octokit;
}

async function clean(): Promise<void> {
  const repoIds = [
    RN_REPO_ID,
    DRIFT_REPO_ID,
    PLATFORM_REPO_ID,
    ADOPTION_REPO_ID,
    CLASSIFICATION_REPO_ID,
  ].map(BigInt);
  await prisma.repositoryRegistration.deleteMany({ where: { repoId: { in: repoIds } } });
  await prisma.app.deleteMany({ where: { repoId: { in: repoIds } } });
  await prisma.app.deleteMany({ where: { repoFullName: "seorilabs/discovery-adoption" } });
}

async function main(): Promise<void> {
  await clean();
  const dependencies = {
    client: prisma,
    now: () => new Date(),
  };
  try {
    const files = {
      "package.json": JSON.stringify({
        name: "discovery-canary",
        packageManager: "pnpm@11.3.0",
        dependencies: { "react-native": "0.81.0" },
        forbidden: CANARY,
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "android/app/build.gradle": 'android { defaultConfig { applicationId "com.seorilabs.discovery" } }',
    };
    const registered = await registerRepositoryWebhook({
      event: "repository",
      action: "created",
      repository: {
        id: RN_REPO_ID,
        full_name: "seorilabs/discovery-canary",
        name: "discovery-canary",
        default_branch: "main",
        private: true,
      },
      deliveryId: "discovery-integration-created",
      organization: "seorilabs",
    }, dependencies);
    assert.equal(registered.enqueued, true);
    const pendingRegistration = await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(RN_REPO_ID) },
    });
    assert.equal(pendingRegistration.status, "REGISTERED");
    assert.equal(pendingRegistration.lastDefaultPushSha, null);
    assert.equal(pendingRegistration.lastReconciledSha, null);
    const pendingSemanticReplay = await registerRepositoryWebhook({
      event: "repository",
      action: "created",
      repository: {
        id: RN_REPO_ID,
        full_name: "seorilabs/discovery-canary",
        name: "discovery-canary",
        default_branch: "main",
        private: true,
      },
      deliveryId: "discovery-integration-created-semantic-replay",
      organization: "seorilabs",
    }, dependencies);
    assert.equal(pendingSemanticReplay.duplicate, true);
    assert.equal((await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(RN_REPO_ID) },
    })).status, "REGISTERED", "pending semantic replay가 MANAGED 상태를 복원하면 안 된다");
    const [firstClaim, secondClaim] = await Promise.all([
      claimRepositoryDiscoveryRun("integration-worker-a", {
        ...dependencies,
        getOctokit: async () => fakeOctokit({ repoId: RN_REPO_ID, fullName: "seorilabs/discovery-canary", headSha: SOURCE_SHA, files }),
      }),
      claimRepositoryDiscoveryRun("integration-worker-b", {
        ...dependencies,
        getOctokit: async () => fakeOctokit({ repoId: RN_REPO_ID, fullName: "seorilabs/discovery-canary", headSha: SOURCE_SHA, files }),
      }),
    ]);
    const claims = [firstClaim, secondClaim].filter((claim) => claim !== null);
    assert.equal(claims.length, 1, "동시 claim 중 하나만 성공해야 한다");
    const claim = claims[0]!;
    const processed = await processRepositoryDiscoveryClaim(claim, {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: RN_REPO_ID,
        fullName: "seorilabs/discovery-canary",
        headSha: SOURCE_SHA,
        files,
      }),
    });
    assert.equal(processed.status, "MANAGED");

    const [registration, app, observations, runs] = await Promise.all([
      prisma.repositoryRegistration.findUniqueOrThrow({ where: { repoId: BigInt(RN_REPO_ID) } }),
      prisma.app.findUniqueOrThrow({ where: { repoId: BigInt(RN_REPO_ID) } }),
      prisma.discoveryObservation.findMany({ where: { app: { repoId: BigInt(RN_REPO_ID) } } }),
      prisma.repositoryDiscoveryRun.findMany({ where: { repoId: BigInt(RN_REPO_ID) } }),
    ]);
    assert.equal(registration.status, "MANAGED");
    assert.equal(registration.managementKind, "APP");
    assert.equal(registration.lastDefaultPushSha, SOURCE_SHA);
    assert.equal(registration.lastReconciledSha, SOURCE_SHA);
    assert.equal(app.status, "ACTIVE");
    assert.equal(app.engine, "RN");
    assert.equal(observations.length, 1);
    assert.equal(runs[0].observationId, observations[0].id);
    assert.ok(
      runs[0].createdAt.getTime() - registration.createdAt.getTime()
        <= REPOSITORY_REGISTRATION_SLO_MS,
      "webhook registration과 durable enqueue는 5분 SLO 안에 끝나야 한다",
    );
    assert.equal(JSON.stringify(observations[0].payload).includes(CANARY), false);

    const ratificationQueueItem = (await getRepositoryClassificationQueue())
      .find((item) => item.repoId === RN_REPO_ID.toString());
    assert.ok(ratificationQueueItem);
    assert.equal(ratificationQueueItem.mode, "RATIFY_CURRENT");
    assert.equal(ratificationQueueItem.currentClassification, "PRODUCT_APP");
    assert.equal(ratificationQueueItem.candidates[0]?.markerPath, "package.json");
    const ratification = await recordRepositoryClassificationDecision({
      request: {
        schemaVersion: 1,
        repoId: BigInt(RN_REPO_ID),
        expectedGeneration: ratificationQueueItem.generation,
        expectedDecisionRevision: ratificationQueueItem.decisionRevision,
        classification: "PRODUCT_APP",
        candidateMarkerPath: "package.json",
        justification: "CURRENT_OBSERVATION_RATIFIED",
      },
      actor: "integration:admin",
      idempotencyKey: "classification-ratify-current-rn",
    });
    assert.equal(ratification.runId, null);
    assert.equal(ratification.generation, null);
    assert.equal((await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(RN_REPO_ID) },
    })).classificationDecisionVersion, 1);
    assert.equal((await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(RN_REPO_ID) },
    })).status, "MANAGED");
    assert.equal(await prisma.repositoryDiscoveryRun.count({
      where: { repoId: BigInt(RN_REPO_ID) },
    }), 1, "ratification은 discovery를 enqueue하지 않아야 한다");
    assert.equal(await prisma.auditLog.count({
      where: {
        action: "control-plane.repository-classification.ratified",
        entityId: ratification.decision.id,
      },
    }), 1);
    const ratificationReplay = await recordRepositoryClassificationDecision({
      request: {
        schemaVersion: 1,
        repoId: BigInt(RN_REPO_ID),
        expectedGeneration: ratificationQueueItem.generation,
        expectedDecisionRevision: ratificationQueueItem.decisionRevision,
        classification: "PRODUCT_APP",
        candidateMarkerPath: "package.json",
        justification: "CURRENT_OBSERVATION_RATIFIED",
      },
      actor: "integration:admin",
      idempotencyKey: "classification-ratify-current-rn",
    });
    assert.equal(ratificationReplay.duplicate, true);
    assert.equal(ratificationReplay.runId, null);

    const duplicate = await registerRepositoryWebhook({
      event: "repository",
      action: "created",
      repository: {
        id: RN_REPO_ID,
        full_name: "seorilabs/discovery-canary",
        name: "discovery-canary",
        default_branch: "main",
        private: true,
      },
      deliveryId: "discovery-integration-created",
      organization: "seorilabs",
    }, dependencies);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await prisma.repositoryDiscoveryRun.count({ where: { repoId: BigInt(RN_REPO_ID) } })), 1);

    const semanticDuplicate = await registerRepositoryWebhook({
      event: "repository",
      action: "created",
      repository: {
        id: RN_REPO_ID,
        full_name: "seorilabs/discovery-canary",
        name: "discovery-canary",
        default_branch: "main",
        private: true,
      },
      deliveryId: "discovery-integration-created-redelivery",
      organization: "seorilabs",
    }, dependencies);
    assert.equal(semanticDuplicate.duplicate, true);
    assert.equal((await prisma.repositoryDiscoveryRun.count({ where: { repoId: BigInt(RN_REPO_ID) } })), 1);

    await registerRepositoryWebhook({
      event: "push",
      repository: {
        id: RN_REPO_ID,
        full_name: "seorilabs/discovery-canary",
        name: "discovery-canary",
        default_branch: "main",
        private: true,
      },
      ref: "refs/heads/main",
      after: NEW_SHA,
      deliveryId: "discovery-integration-push-two",
      organization: "seorilabs",
    }, dependencies);
    const pushedRegistration = await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(RN_REPO_ID) },
    });
    assert.equal(pushedRegistration.status, "REGISTERED");
    assert.equal(pushedRegistration.lastDefaultPushSha, NEW_SHA);
    assert.equal(pushedRegistration.lastReconciledSha, SOURCE_SHA);
    const staleWorkerClaim = await claimRepositoryDiscoveryRun("integration-worker-stale", {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: RN_REPO_ID,
        fullName: "seorilabs/discovery-canary",
        headSha: NEW_SHA,
        files,
      }),
    });
    assert.ok(staleWorkerClaim);
    const latestSha = "d".repeat(40);
    await registerRepositoryWebhook({
      event: "push",
      repository: {
        id: RN_REPO_ID,
        full_name: "seorilabs/discovery-canary",
        name: "discovery-canary",
        default_branch: "main",
        private: true,
      },
      ref: "refs/heads/main",
      after: latestSha,
      deliveryId: "discovery-integration-push-three",
      organization: "seorilabs",
    }, dependencies);
    const staleCompletion = await processRepositoryDiscoveryClaim(staleWorkerClaim, {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: RN_REPO_ID,
        fullName: "seorilabs/discovery-canary",
        headSha: NEW_SHA,
        files,
      }),
    });
    assert.equal(staleCompletion.status, "DISCARDED");
    assert.equal(await prisma.discoveryObservation.count({
      where: { app: { repoId: BigInt(RN_REPO_ID) } },
    }), 1, "새 generation 뒤 stale worker는 observation을 추가할 수 없다");
    await prisma.repositoryRegistration.delete({ where: { repoId: BigInt(RN_REPO_ID) } });
    await prisma.app.delete({ where: { repoId: BigInt(RN_REPO_ID) } });

    await registerRepositoryWebhook({
      event: "push",
      repository: {
        id: DRIFT_REPO_ID,
        full_name: "seorilabs/discovery-drift",
        name: "discovery-drift",
        default_branch: "main",
        private: true,
      },
      ref: "refs/heads/main",
      after: SOURCE_SHA,
      deliveryId: "discovery-integration-drift",
      organization: "seorilabs",
    }, dependencies);
    const driftClaim = await claimRepositoryDiscoveryRun("integration-worker-drift", {
      ...dependencies,
      getOctokit: async () => fakeOctokit({ repoId: DRIFT_REPO_ID, fullName: "seorilabs/discovery-drift", headSha: NEW_SHA, files }),
    });
    assert.ok(driftClaim);
    const drift = await processRepositoryDiscoveryClaim(driftClaim, {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: DRIFT_REPO_ID,
        fullName: "seorilabs/discovery-drift",
        headSha: NEW_SHA,
        files,
      }),
    });
    assert.equal(drift.status, "STALE");
    const driftRuns = await prisma.repositoryDiscoveryRun.findMany({
      where: { repoId: BigInt(DRIFT_REPO_ID) },
      orderBy: { generation: "asc" },
    });
    assert.deepEqual(driftRuns.map((run) => [run.status, run.sourceSha]), [
      ["STALE", SOURCE_SHA],
      ["QUEUED", NEW_SHA],
    ]);
    await prisma.repositoryRegistration.delete({ where: { repoId: BigInt(DRIFT_REPO_ID) } });

    const platformFiles = {
      "package.json": JSON.stringify({ name: "seorilabs-platform", packageManager: "pnpm@11.3.0" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "spec/openapi.yaml": "openapi: 3.1.0\n",
      "sdk-gdscript/project.godot": "[application]\n",
    };
    await registerRepositoryWebhook({
      event: "repository",
      action: "created",
      repository: {
        id: PLATFORM_REPO_ID,
        full_name: "seorilabs/platform",
        name: "platform",
        default_branch: "main",
        private: true,
      },
      deliveryId: "discovery-integration-platform",
      organization: "seorilabs",
    }, dependencies);
    const platformClaim = await claimRepositoryDiscoveryRun("integration-worker-platform", {
      ...dependencies,
      getOctokit: async () => fakeOctokit({ repoId: PLATFORM_REPO_ID, fullName: "seorilabs/platform", headSha: SOURCE_SHA, files: platformFiles }),
    });
    assert.ok(platformClaim);
    const platform = await processRepositoryDiscoveryClaim(platformClaim, {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: PLATFORM_REPO_ID,
        fullName: "seorilabs/platform",
        headSha: SOURCE_SHA,
        files: platformFiles,
      }),
    });
    assert.equal(platform.status, "EXCLUDED", JSON.stringify(platform));
    const platformRegistration = await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(PLATFORM_REPO_ID) },
    });
    assert.equal(platformRegistration.status, "MANAGED");
    assert.equal(platformRegistration.managementKind, "PLATFORM_PRODUCER");
    assert.equal(await prisma.app.count({ where: { repoId: BigInt(PLATFORM_REPO_ID) } }), 0);

    await prisma.app.create({
      data: {
        slug: "discovery-adoption",
        displayName: "Discovery Adoption",
        repoFullName: "seorilabs/discovery-adoption",
        type: "APP",
        engine: "RN",
        status: "ACTIVE",
        playPackage: "com.seorilabs.wrong",
        marketTargets: ["play"],
      },
    });
    await registerRepositoryWebhook({
      event: "repository",
      action: "created",
      repository: {
        id: ADOPTION_REPO_ID,
        full_name: "seorilabs/discovery-adoption",
        name: "discovery-adoption",
        default_branch: "main",
        private: true,
      },
      deliveryId: "discovery-integration-adoption",
      organization: "seorilabs",
    }, dependencies);
    const adoptionClaim = await claimRepositoryDiscoveryRun("integration-worker-adoption", {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: ADOPTION_REPO_ID,
        fullName: "seorilabs/discovery-adoption",
        headSha: SOURCE_SHA,
        files,
      }),
    });
    assert.ok(adoptionClaim);
    const adoption = await processRepositoryDiscoveryClaim(adoptionClaim, {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: ADOPTION_REPO_ID,
        fullName: "seorilabs/discovery-adoption",
        headSha: SOURCE_SHA,
        files,
      }),
    });
    assert.equal(adoption.status, "NEEDS_INPUT");
    assert.equal(adoption.reasonCode, "APP_MARKET_IDENTITY_CONFLICT");
    const adoptionRegistration = await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(ADOPTION_REPO_ID) },
    });
    assert.equal(adoptionRegistration.status, "NEEDS_INPUT");
    assert.equal(adoptionRegistration.lastDiscoveryReason, "APP_MARKET_IDENTITY_CONFLICT");
    await registerRepositoryWebhook({
      event: "push",
      repository: {
        id: ADOPTION_REPO_ID,
        full_name: "seorilabs/discovery-adoption",
        name: "discovery-adoption",
        default_branch: "main",
        private: true,
      },
      ref: "refs/tags/v1.0.0",
      after: NEW_SHA,
      deliveryId: "discovery-integration-adoption-tag",
      organization: "seorilabs",
    }, dependencies);
    assert.equal((await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(ADOPTION_REPO_ID) },
    })).status, "NEEDS_INPUT", "irrelevant tag push가 identity conflict를 지우면 안 된다");
    const adoptionApp = await prisma.app.findUniqueOrThrow({
      where: { repoFullName: "seorilabs/discovery-adoption" },
    });
    assert.equal(adoptionApp.repoId, null);
    assert.equal(adoptionApp.playPackage, "com.seorilabs.wrong");

    const classificationFiles = { "README.md": "internal repository\n" };
    await registerRepositoryWebhook({
      event: "repository",
      action: "created",
      repository: {
        id: CLASSIFICATION_REPO_ID,
        full_name: "seorilabs/discovery-classification",
        name: "discovery-classification",
        default_branch: "main",
        private: true,
        fork: false,
      },
      deliveryId: "discovery-integration-classification",
      organization: "seorilabs",
    }, dependencies);
    const classificationClaim = await claimRepositoryDiscoveryRun("integration-worker-classification", {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: CLASSIFICATION_REPO_ID,
        fullName: "seorilabs/discovery-classification",
        headSha: SOURCE_SHA,
        files: classificationFiles,
      }),
    });
    assert.ok(classificationClaim);
    const unresolved = await processRepositoryDiscoveryClaim(classificationClaim, {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: CLASSIFICATION_REPO_ID,
        fullName: "seorilabs/discovery-classification",
        headSha: SOURCE_SHA,
        files: classificationFiles,
      }),
    });
    assert.equal(unresolved.status, "NEEDS_INPUT");
    assert.equal(unresolved.reasonCode, "NO_CANDIDATE");
    await prisma.repositoryRegistration.update({
      where: { repoId: BigInt(CLASSIFICATION_REPO_ID) },
      data: { classificationDecisionVersion: null },
    });
    const unresolvedRegistration = await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(CLASSIFICATION_REPO_ID) },
    });
    assert.equal(unresolvedRegistration.classificationDecisionVersion, null);
    const decisionBase = {
      schemaVersion: 1 as const,
      repoId: BigInt(CLASSIFICATION_REPO_ID),
      expectedGeneration: unresolvedRegistration.reconcileGeneration ?? 0,
      expectedDecisionRevision: unresolvedRegistration.classificationDecisionVersion ?? 0,
      candidateMarkerPath: null,
      justification: "REPOSITORY_PURPOSE_CONFIRMED" as const,
    };
    const concurrent = await Promise.allSettled([
      recordRepositoryClassificationDecision({
        request: { ...decisionBase, classification: "INFRA_REPO" },
        actor: "integration:human",
        idempotencyKey: "classification-cas-infra",
      }),
      recordRepositoryClassificationDecision({
        request: { ...decisionBase, classification: "EXCLUDED" },
        actor: "integration:ai",
        idempotencyKey: "classification-cas-excluded",
      }),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => (
      result.status === "rejected"
      && result.reason instanceof ControlPlaneError
      && result.reason.code === "REPOSITORY_CLASSIFICATION_CONFLICT"
    )).length, 1);
    const winning = concurrent.find((result) => result.status === "fulfilled");
    assert.ok(winning?.status === "fulfilled");
    const winningDecision = winning.value;
    const replay = await recordRepositoryClassificationDecision({
      request: {
        ...decisionBase,
        classification: winningDecision.decision.classification,
      },
      actor: winningDecision.decision.createdBy,
      idempotencyKey: winningDecision.decision.classification === "INFRA_REPO"
        ? "classification-cas-infra"
        : "classification-cas-excluded",
    });
    assert.equal(replay.duplicate, true);
    assert.equal(await prisma.repositoryClassificationDecision.count({
      where: { repoId: BigInt(CLASSIFICATION_REPO_ID) },
    }), 1, "동시 분류 CAS는 append-only decision을 하나만 남겨야 한다");
    const decisionGeneration = (await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(CLASSIFICATION_REPO_ID) },
    })).reconcileGeneration;
    const decisionRunCount = await prisma.repositoryDiscoveryRun.count({
      where: { repoId: BigInt(CLASSIFICATION_REPO_ID) },
    });
    await assert.rejects(registerRepositoryWebhook({
      event: "reconcile",
      action: "source-drift",
      repository: {
        id: CLASSIFICATION_REPO_ID,
        full_name: "seorilabs/discovery-classification",
        name: "discovery-classification",
        default_branch: "main",
        archived: false,
        private: true,
        fork: false,
      },
      after: NEW_SHA,
      deliveryId: "classification-stale-zero-revision",
      organization: "seorilabs",
      classificationDecisionRevision: 0,
    }, dependencies), /REPOSITORY_CLASSIFICATION_REVISION_STALE/);
    assert.equal((await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(CLASSIFICATION_REPO_ID) },
    })).reconcileGeneration, decisionGeneration, "분류 전 worker가 새 decision generation을 덮으면 안 된다");
    assert.equal(await prisma.repositoryDiscoveryRun.count({
      where: { repoId: BigInt(CLASSIFICATION_REPO_ID) },
    }), decisionRunCount, "stale revision enqueue는 새 run을 만들면 안 된다");

    const interruptedClaim = await claimRepositoryDiscoveryRun("integration-worker-interrupted", {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: CLASSIFICATION_REPO_ID,
        fullName: "seorilabs/discovery-classification",
        headSha: SOURCE_SHA,
        files: classificationFiles,
      }),
    });
    assert.ok(interruptedClaim);
    await prisma.repositoryDiscoveryRun.update({
      where: { id: interruptedClaim.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const recovered = await recoverRepositoryDiscoveryRuns({
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: CLASSIFICATION_REPO_ID,
        fullName: "seorilabs/discovery-classification",
        headSha: SOURCE_SHA,
        files: classificationFiles,
      }),
    });
    assert.equal(recovered.requeued, 1);
    const lateCompletion = await processRepositoryDiscoveryClaim(interruptedClaim, {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: CLASSIFICATION_REPO_ID,
        fullName: "seorilabs/discovery-classification",
        headSha: SOURCE_SHA,
        files: classificationFiles,
      }),
    });
    assert.equal(lateCompletion.status, "DISCARDED", "만료된 worker의 늦은 완료는 거부해야 한다");
    const recoveredClaim = await claimRepositoryDiscoveryRun("integration-worker-recovered", {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: CLASSIFICATION_REPO_ID,
        fullName: "seorilabs/discovery-classification",
        headSha: SOURCE_SHA,
        files: classificationFiles,
      }),
    });
    assert.ok(recoveredClaim);
    const resolved = await processRepositoryDiscoveryClaim(recoveredClaim, {
      ...dependencies,
      getOctokit: async () => fakeOctokit({
        repoId: CLASSIFICATION_REPO_ID,
        fullName: "seorilabs/discovery-classification",
        headSha: SOURCE_SHA,
        files: classificationFiles,
      }),
    });
    assert.equal(resolved.status, "EXCLUDED");
    assert.equal((await prisma.repositoryRegistration.findUniqueOrThrow({
      where: { repoId: BigInt(CLASSIFICATION_REPO_ID) },
    })).classification, winningDecision.decision.classification);
    assert.equal(await prisma.auditLog.count({
      where: {
        action: "control-plane.repository-classification.decided",
        entityId: winningDecision.decision.id,
      },
    }), 1);

    console.log("repository discovery integration 계약 통과");
  } finally {
    await clean();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "repository discovery integration failed");
  process.exitCode = 1;
});
