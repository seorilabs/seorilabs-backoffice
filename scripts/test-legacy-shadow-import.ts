import assert from "node:assert/strict";

import { PrismaClient } from "@prisma/client";

import {
  transformLegacySources,
  type DraftableConfigRevisionPayload,
} from "@/lib/control-plane/legacy-shadow";
import {
  recordLegacyShadowImport,
  listLegacyShadowImports,
  type LegacyShadowServiceDependencies,
} from "@/lib/control-plane/legacy-shadow-service";
import {
  LEGACY_SOURCE_DEFINITIONS,
  type LegacySourceInput,
} from "@/lib/control-plane/legacy-sources";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { activateConfigRevision, ControlPlaneError } from "@/lib/control-plane/service";
import type { Octokit } from "@/lib/github/app";

const APP_ID = "legacy-shadow-integration-app";
const SECOND_APP_ID = "legacy-shadow-integration-other-app";
const SECOND_CONFIG_ID = "legacy-shadow-integration-other-config";
const APP_REPO_ID = 9_999_991n;
const PLATFORM_REPO_ID = 9_999_992;
const APP_SHA = "a".repeat(40);
const DELAYED_APP_SHA = "9".repeat(40);
const NEXT_APP_SHA = "c".repeat(40);
const PLATFORM_SHA = "b".repeat(40);
const APP_FULL_NAME = "seorilabs/legacy-shadow-integration";
const PLATFORM_FULL_NAME = "seorilabs/platform";
const CANARY_SECRET = "canary-secret-must-not-persist";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("legacy shadow integration fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("legacy shadow integration fixture DB 이름은 _contract_test로 끝나야 한다");
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error("redacted fake GitHub response"), { status });
}

function encodedFile(text: string) {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from(text).toString("base64"),
    sha: "d".repeat(40),
    size: Buffer.byteLength(text),
  };
}

function sourcePath(kind: (typeof LEGACY_SOURCE_DEFINITIONS)[number]["sourceKind"]): string {
  const definition = LEGACY_SOURCE_DEFINITIONS.find((item) => item.sourceKind === kind)!;
  return kind === "PLATFORM_APP_REGISTRY"
    ? "registry/apps/legacy-shadow-integration.json"
    : definition.pathPattern;
}

function sourceVector(googlePayload: Record<string, unknown>): LegacySourceInput[] {
  return LEGACY_SOURCE_DEFINITIONS.map((definition) => ({
    sourceKind: definition.sourceKind,
    repository: definition.repositoryScope === "APP" ? APP_FULL_NAME : PLATFORM_FULL_NAME,
    sourceSha: definition.repositoryScope === "APP" ? APP_SHA : PLATFORM_SHA,
    path: sourcePath(definition.sourceKind),
    status: definition.sourceKind === "GOOGLE_PLAY_CONFIG" ? "PRESENT" : "ABSENT",
    ...(definition.sourceKind === "GOOGLE_PLAY_CONFIG" ? { text: JSON.stringify(googlePayload) } : {}),
  }));
}

function expectedPayload(googlePayload: Record<string, unknown>): DraftableConfigRevisionPayload {
  const result = transformLegacySources(sourceVector(googlePayload));
  assert.equal(result.status, "DRAFTABLE");
  if (result.status !== "DRAFTABLE") throw new Error("fixture payload transform 실패");
  return result.payload;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const previousPlatformRepoId = process.env.PLATFORM_GITHUB_REPOSITORY_ID;
  process.env.PLATFORM_GITHUB_REPOSITORY_ID = String(PLATFORM_REPO_ID);
  const safeGooglePayload = {
    defaultLanguage: "ko-KR",
    build: { minSdk: 23, targetSdk: 35 },
  };
  let googlePayload: Record<string, unknown> = safeGooglePayload;
  let appHeadSha = APP_SHA;
  let appDefaultBranch = "main";
  let contentHook: (() => Promise<void>) | null = null;
  let githubCalls = 0;
  const fakeOctokit = {
    rest: {
      repos: {
        async get(args: { owner: string; repo: string }) {
          githubCalls += 1;
          if (`${args.owner}/${args.repo}` === APP_FULL_NAME) {
            return { data: { id: Number(APP_REPO_ID), full_name: APP_FULL_NAME, default_branch: appDefaultBranch } };
          }
          if (`${args.owner}/${args.repo}` === PLATFORM_FULL_NAME) {
            return { data: { id: PLATFORM_REPO_ID, full_name: PLATFORM_FULL_NAME, default_branch: "main" } };
          }
          throw httpError(404);
        },
        async getCommit(args: { owner: string; repo: string; ref: string }) {
          githubCalls += 1;
          if (`${args.owner}/${args.repo}` === APP_FULL_NAME) {
            return { data: { sha: args.ref === appDefaultBranch ? appHeadSha : args.ref } };
          }
          if (`${args.owner}/${args.repo}` === PLATFORM_FULL_NAME) {
            return { data: { sha: args.ref } };
          }
          throw httpError(404);
        },
        async getContent(args: { owner: string; repo: string; path: string; ref: string }) {
          githubCalls += 1;
          const hook = contentHook;
          contentHook = null;
          if (hook) await hook();
          if (`${args.owner}/${args.repo}` === APP_FULL_NAME
            && args.path === "play-store/google-play.config.json") {
            return { data: encodedFile(JSON.stringify(googlePayload)) };
          }
          throw httpError(404);
        },
      },
    },
  } as unknown as Octokit;
  let clock = Date.parse("2026-08-28T00:00:00.000Z");
  const dependencies: LegacyShadowServiceDependencies = {
    client: prisma,
    getOctokit: async () => fakeOctokit,
    now: () => new Date(clock += 1_000),
  };

  async function discovery(
    sourceSha: string,
    suffix: string,
    observedAt: Date,
    createdAt = observedAt,
  ) {
    await prisma.discoveryObservation.create({
      data: {
        appId: APP_ID,
        sourceSha,
        sourceRef: "refs/heads/main",
        payload: {},
        payloadHash: jsonDigest({}),
        requestHash: jsonDigest({ suffix } as JsonValue),
        idempotencyKey: `legacy-shadow-discovery-${suffix}`,
        observedBy: "integration-worker",
        observedAt,
        createdAt,
      },
    });
  }

  await prisma.auditLog.deleteMany({
    where: {
      action: "control-plane.legacy-shadow.record",
      payload: { path: "$.appId", equals: APP_ID },
    },
  });
  await prisma.legacyConfigImport.deleteMany({
    where: { appId: { in: [APP_ID, SECOND_APP_ID] } },
  });
  await prisma.app.deleteMany({ where: { id: { in: [APP_ID, SECOND_APP_ID] } } });
  try {
    const payload = expectedPayload(safeGooglePayload);
    await prisma.app.create({
      data: {
        id: APP_ID,
        slug: "legacy-shadow-integration",
        displayName: "Legacy Shadow Integration",
        repoFullName: APP_FULL_NAME,
        repoId: APP_REPO_ID,
        type: "APP",
        engine: "RN",
        marketTargets: ["play"],
      },
    });
    await discovery(APP_SHA, "initial", new Date("2026-08-28T00:00:00.000Z"));
    await discovery(
      DELAYED_APP_SHA,
      "delayed-old",
      new Date("2026-08-27T23:59:00.000Z"),
      new Date("2026-08-28T00:01:00.000Z"),
    );
    await prisma.platformFleetBinding.create({
      data: { appId: APP_ID, state: "MANAGED", sourceSha: PLATFORM_SHA },
    });
    await prisma.configRevision.create({
      data: {
        id: "legacy-shadow-integration-active",
        appId: APP_ID,
        revision: 1,
        status: "ACTIVE",
        activeSlot: APP_ID,
        payload,
        payloadHash: jsonDigest(payload as JsonValue),
        createdBy: "integration-human",
        idempotencyKey: "legacy-shadow-integration-active-create",
      },
    });
    await prisma.app.create({
      data: {
        id: SECOND_APP_ID,
        slug: "legacy-shadow-integration-other",
        displayName: "Legacy Shadow Integration Other",
        repoFullName: "seorilabs/legacy-shadow-integration-other",
        repoId: APP_REPO_ID + 1n,
        type: "APP",
        engine: "RN",
        marketTargets: ["play"],
      },
    });
    await prisma.configRevision.create({
      data: {
        id: SECOND_CONFIG_ID,
        appId: SECOND_APP_ID,
        revision: 1,
        status: "DRAFT",
        payload,
        payloadHash: jsonDigest(payload as JsonValue),
        createdBy: "integration-human",
        idempotencyKey: "legacy-shadow-integration-other-config-create",
      },
    });

    const first = await recordLegacyShadowImport({
      repoId: APP_REPO_ID,
      sourceSha: APP_SHA,
      observedBy: "integration-worker",
      idempotencyKey: "legacy-shadow-integration-first",
    }, dependencies);
    assert.equal(first.duplicate, false);
    assert.equal(first.import.status, "DRAFT_CREATED");
    assert.equal(first.parity?.status, "MATCH");
    assert.equal(first.sourceCount, 7);
    assert.equal(first.import.sourceRef, "refs/heads/main");
    assert.equal(first.import.sources.every((source) => typeof source.repoId === "string"), true);
    assert.doesNotThrow(() => JSON.stringify(first));
    assert.equal("requestHash" in first.import, false);

    await assert.rejects(
      prisma.app.delete({ where: { id: APP_ID } }),
      (error) => (error as { code?: unknown } | null)?.code === "P2003",
    );
    assert.equal(await prisma.app.count({ where: { id: APP_ID } }), 1);
    await assert.rejects(
      prisma.app.update({
        where: { id: APP_ID },
        data: { id: "legacy-shadow-integration-app-renamed" },
      }),
      (error) => (error as { code?: unknown } | null)?.code === "P2003",
    );
    assert.equal(await prisma.app.count({ where: { id: APP_ID } }), 1);

    await assert.rejects(prisma.$executeRaw`
      INSERT INTO control_plane_legacy_config_import (
        id, appId, sourceSha, transformVersion, requestHash, inputDigest, status,
        idempotencyKey, configRevisionId, observedBy, observedAt, createdAt
      ) VALUES (
        'legacy-shadow-cross-app-import', ${APP_ID}, ${APP_SHA}, 'integration-v1',
        ${"1".repeat(64)}, ${"2".repeat(64)}, 'DRAFT_CREATED',
        ${"3".repeat(64)}, ${SECOND_CONFIG_ID}, 'integration-worker', NOW(3), NOW(3)
      )
    `);
    await assert.rejects(prisma.$executeRaw`
      INSERT INTO control_plane_shadow_parity_observation (
        id, appId, legacyImportId, configRevisionId, sourceSha, scope,
        contractVersion, status, dedupeKey, observedBy, observedAt, createdAt
      ) VALUES (
        'legacy-shadow-cross-app-import-parity', ${SECOND_APP_ID}, ${first.import.id},
        ${SECOND_CONFIG_ID}, ${APP_SHA}, 'FULL', 'integration-v1', 'MATCH',
        ${"4".repeat(64)}, 'integration-worker', NOW(3), NOW(3)
      )
    `);
    await assert.rejects(prisma.$executeRaw`
      INSERT INTO control_plane_shadow_parity_observation (
        id, appId, legacyImportId, configRevisionId, sourceSha, scope,
        contractVersion, status, dedupeKey, observedBy, observedAt, createdAt
      ) VALUES (
        'legacy-shadow-cross-app-config-parity', ${APP_ID}, ${first.import.id},
        ${SECOND_CONFIG_ID}, ${APP_SHA}, 'FULL', 'integration-v1', 'MATCH',
        ${"5".repeat(64)}, 'integration-worker', NOW(3), NOW(3)
      )
    `);

    const importedRevision = first.configRevision?.revision;
    assert.equal(typeof importedRevision, "number");
    await assert.rejects(
      activateConfigRevision({
        repoId: APP_REPO_ID,
        revision: importedRevision!,
        expectedActiveRevision: 1,
        actor: "integration-human",
        idempotencyKey: "legacy-shadow-integration-activation",
        signingKey: "integration-signing-key",
      }),
      (error) => error instanceof ControlPlaneError
        && error.code === "SHADOW_IMPORT_NOT_ACTIVATABLE",
    );

    const callsBeforeReplay = githubCalls;
    const replay = await recordLegacyShadowImport({
      repoId: APP_REPO_ID,
      sourceSha: APP_SHA,
      observedBy: "integration-worker",
      idempotencyKey: "legacy-shadow-integration-first",
    }, dependencies);
    assert.equal(replay.duplicate, true);
    assert.equal(githubCalls, callsBeforeReplay);
    await assert.rejects(
      recordLegacyShadowImport({
        repoId: APP_REPO_ID,
        sourceSha: NEXT_APP_SHA,
        observedBy: "integration-worker",
        idempotencyKey: "legacy-shadow-integration-first",
      }, dependencies),
      (error) => error instanceof ControlPlaneError && error.code === "IDEMPOTENCY_CONFLICT",
    );

    process.env.PLATFORM_GITHUB_REPOSITORY_ID = "123";
    const wrongPlatformIdentity = await recordLegacyShadowImport({
      repoId: APP_REPO_ID,
      sourceSha: APP_SHA,
      observedBy: "integration-worker",
      idempotencyKey: "legacy-shadow-integration-platform-repo-mismatch",
    }, dependencies);
    assert.equal(wrongPlatformIdentity.import.status, "NEEDS_INPUT");
    assert.ok(wrongPlatformIdentity.import.sources.some((source) => (
      source.sourceKind === "PLATFORM_APP_REGISTRY"
      && source.errorCode === "PLATFORM_REPOSITORY_IDENTITY_INVALID"
    )));
    process.env.PLATFORM_GITHUB_REPOSITORY_ID = String(PLATFORM_REPO_ID);

    const concurrent = await Promise.all([
      recordLegacyShadowImport({
        repoId: APP_REPO_ID,
        sourceSha: APP_SHA,
        observedBy: "integration-worker",
        idempotencyKey: "legacy-shadow-integration-concurrent",
      }, dependencies),
      recordLegacyShadowImport({
        repoId: APP_REPO_ID,
        sourceSha: APP_SHA,
        observedBy: "integration-worker",
        idempotencyKey: "legacy-shadow-integration-concurrent",
      }, dependencies),
    ]);
    assert.equal(concurrent.filter((result) => !result.duplicate).length, 1);
    assert.equal(concurrent.filter((result) => result.duplicate).length, 1);

    appHeadSha = NEXT_APP_SHA;
    await discovery(NEXT_APP_SHA, "next", new Date("2026-08-28T01:00:00.000Z"));
    googlePayload = { ...safeGooglePayload, apiKey: CANARY_SECRET };
    const blocked = await recordLegacyShadowImport({
      repoId: APP_REPO_ID,
      sourceSha: NEXT_APP_SHA,
      observedBy: "integration-worker",
      idempotencyKey: "legacy-shadow-integration-secret",
    }, dependencies);
    assert.equal(blocked.import.status, "NEEDS_INPUT");
    assert.equal(blocked.configRevision, null);
    assert.equal(
      blocked.import.sources.every((source) => source.blobSha === null && source.contentSha256 === null),
      true,
    );
    const blockedTransform = transformLegacySources(sourceVector(googlePayload));
    assert.equal(blockedTransform.status, "NEEDS_INPUT");
    assert.notEqual(blocked.import.inputDigest, blockedTransform.inputDigest);
    const persisted = await prisma.legacyConfigImport.findMany({
      where: { appId: APP_ID },
      include: { sources: true, parityObservations: true, configRevision: true },
    });
    const audits = await prisma.auditLog.findMany({
      where: { action: "control-plane.legacy-shadow.record", payload: { path: "$.appId", equals: APP_ID } },
    });
    const serialized = JSON.stringify({ persisted, audits }, (_, value) => (
      typeof value === "bigint" ? value.toString() : value
    ));
    assert.doesNotMatch(serialized, new RegExp(CANARY_SECRET));

    await assert.rejects(
      recordLegacyShadowImport({
        repoId: APP_REPO_ID,
        sourceSha: APP_SHA,
        observedBy: "integration-worker",
        idempotencyKey: "legacy-shadow-integration-stale",
      }, dependencies),
      (error) => error instanceof ControlPlaneError && error.code === "SOURCE_SHA_NOT_CURRENT",
    );
    appHeadSha = "e".repeat(40);
    await assert.rejects(
      recordLegacyShadowImport({
        repoId: APP_REPO_ID,
        sourceSha: NEXT_APP_SHA,
        observedBy: "integration-worker",
        idempotencyKey: "legacy-shadow-integration-not-head",
      }, dependencies),
      (error) => error instanceof ControlPlaneError && error.code === "SOURCE_SHA_NOT_DEFAULT_HEAD",
    );
    appHeadSha = NEXT_APP_SHA;

    contentHook = async () => {
      appHeadSha = "d".repeat(40);
    };
    await assert.rejects(
      recordLegacyShadowImport({
        repoId: APP_REPO_ID,
        sourceSha: NEXT_APP_SHA,
        observedBy: "integration-worker",
        idempotencyKey: "legacy-shadow-integration-head-race",
      }, dependencies),
      (error) => error instanceof ControlPlaneError
        && error.code === "SOURCE_SHA_CHANGED_DURING_READ",
    );
    appHeadSha = NEXT_APP_SHA;

    contentHook = async () => {
      appDefaultBranch = "release";
    };
    await assert.rejects(
      recordLegacyShadowImport({
        repoId: APP_REPO_ID,
        sourceSha: NEXT_APP_SHA,
        observedBy: "integration-worker",
        idempotencyKey: "legacy-shadow-integration-default-branch-race",
      }, dependencies),
      (error) => error instanceof ControlPlaneError
        && error.code === "SOURCE_REF_CHANGED_DURING_READ",
    );
    appDefaultBranch = "main";

    googlePayload = safeGooglePayload;
    contentHook = async () => {
      await prisma.platformFleetBinding.update({
        where: { appId: APP_ID },
        data: { sourceSha: "f".repeat(40) },
      });
    };
    await assert.rejects(
      recordLegacyShadowImport({
        repoId: APP_REPO_ID,
        sourceSha: NEXT_APP_SHA,
        observedBy: "integration-worker",
        idempotencyKey: "legacy-shadow-integration-race",
      }, dependencies),
      (error) => error instanceof ControlPlaneError && error.code === "SOURCE_VECTOR_CHANGED",
    );

    const listed = await listLegacyShadowImports({ repoId: APP_REPO_ID });
    assert.doesNotThrow(() => JSON.stringify(listed));
    assert.equal(listed.imports.every((item) => !("requestHash" in item)), true);
  } finally {
    await prisma.legacyConfigImport.deleteMany({
      where: { appId: { in: [APP_ID, SECOND_APP_ID] } },
    });
    await prisma.app.deleteMany({ where: { id: { in: [APP_ID, SECOND_APP_ID] } } });
    await prisma.auditLog.deleteMany({
      where: {
        action: "control-plane.legacy-shadow.record",
        payload: { path: "$.appId", equals: APP_ID },
      },
    });
    if (previousPlatformRepoId === undefined) delete process.env.PLATFORM_GITHUB_REPOSITORY_ID;
    else process.env.PLATFORM_GITHUB_REPOSITORY_ID = previousPlatformRepoId;
    await prisma.$disconnect();
  }
  console.log("legacy shadow import integration 계약 통과");
}

main().catch((error: unknown) => {
  console.error(
    "legacy shadow import integration 실패:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
});
