import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assertDesiredStateBackfillReplay,
  assessDesiredStateCandidate,
  DESIRED_STATE_BACKFILL_CONTRACT_VERSION,
  desiredStateBackfillAdminInvocation,
  desiredStateBackfillRequestHash,
  type DesiredStateCandidate,
} from "@/lib/control-plane/desired-state-backfill";
import {
  configRevisionPayloadSchema,
  desiredStateBackfillSchema,
} from "@/lib/control-plane/contracts";
import { PROVIDER_ADAPTER_IDS } from "@/lib/control-plane/provider-adapters";
import { REPOSITORY_DISCOVERY_CONTRACT_VERSION } from "@/lib/control-plane/repository-discovery";
import { ControlPlaneError } from "@/lib/control-plane/service";

const SHA = "a".repeat(40);

function candidate(overrides: Partial<DesiredStateCandidate> = {}): DesiredStateCandidate {
  return {
    appId: "app-1",
    slug: "sample-app",
    repoFullName: "seorilabs/sample-app",
    repoId: "42",
    status: "ACTIVE",
    configuredRevision: null,
    registration: {
      repoId: "42",
      status: "MANAGED",
      archived: false,
      managementKind: "APP",
      classification: "PRODUCT_APP",
      discoveryContractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
      lastDefaultPushSha: SHA,
      lastReconciledSha: SHA,
      lastDiscoveryReason: null,
    },
    observation: {
      id: "observation-1",
      sourceSha: SHA,
      sourceRef: "refs/heads/main",
      payloadHash: "b".repeat(64),
      observedAt: new Date("2026-08-29T00:00:00.000Z"),
    },
    buildTargets: [
      { targetKey: "ios", market: "app-store", observedSha: SHA },
      { targetKey: "android", market: "google-play", observedSha: SHA },
      { targetKey: "ait", market: "apps-in-toss", observedSha: SHA },
    ],
    ...overrides,
  };
}

test("ACTIVE 앱의 repoId 누락을 cohort 밖으로 숨기지 않고 NEEDS_INPUT으로 만든다", () => {
  assert.deepEqual(assessDesiredStateCandidate(candidate({ repoId: null, registration: null })), {
    outcome: "NEEDS_INPUT",
    reason: "APP_REPO_ID_MISSING",
    detail: null,
  });
});

test("legacy 또는 non-product repository는 중앙 DRAFT 대상이 아니다", () => {
  const legacy = assessDesiredStateCandidate(candidate({
    registration: { ...candidate().registration!, classification: null },
  }));
  assert.equal(legacy.outcome, "NEEDS_INPUT");
  if (legacy.outcome === "NEEDS_INPUT") assert.equal(legacy.reason, "REPOSITORY_CLASSIFICATION_PENDING");

  const infra = assessDesiredStateCandidate(candidate({
    registration: { ...candidate().registration!, classification: "INFRA_REPO" },
  }));
  assert.equal(infra.outcome, "NEEDS_INPUT");
  if (infra.outcome === "NEEDS_INPUT") assert.equal(infra.reason, "REPOSITORY_NOT_PRODUCT_APP");
});

test("keeum·animal-chess·immunity-war·merge-lizard 형태는 구성을 추측하지 않고 정확한 source/build gate로 멈춘다", () => {
  const cases = [
    ["NO_CANDIDATE", "PRODUCT_SOURCE_CANDIDATE_MISSING"],
    ["BUILD_TARGET_MISSING", "PRODUCT_BUILD_TARGET_MISSING"],
    ["TREE_TRUNCATED", "PRODUCT_DISCOVERY_NOT_READY"],
  ] as const;
  for (const [lastDiscoveryReason, expectedReason] of cases) {
    const result = assessDesiredStateCandidate(candidate({
      registration: {
        ...candidate().registration!,
        status: "NEEDS_INPUT",
        lastDiscoveryReason,
      },
      observation: null,
      buildTargets: [],
    }));
    assert.deepEqual(result, {
      outcome: "NEEDS_INPUT",
      reason: expectedReason,
      detail: lastDiscoveryReason,
    });
  }
});

test("exact source가 어긋나면 오래된 observation으로 DRAFT를 만들지 않는다", () => {
  const result = assessDesiredStateCandidate(candidate({
    registration: { ...candidate().registration!, lastDefaultPushSha: "c".repeat(40) },
  }));
  assert.equal(result.outcome, "NEEDS_INPUT");
  if (result.outcome === "NEEDS_INPUT") assert.equal(result.reason, "DISCOVERY_SOURCE_STALE");
});

test("확인된 build target만 market DRAFT로 만들고 사람/provider 필드는 추측하지 않는다", () => {
  const result = assessDesiredStateCandidate(candidate());
  assert.equal(result.outcome, "READY");
  if (result.outcome !== "READY") return;
  assert.deepEqual(result.payload, {
    schemaVersion: 1,
    markets: [
      { market: "google-play", enabled: true, locales: [], releaseChannel: "internal" },
      { market: "app-store", enabled: true, locales: [], releaseChannel: "testflight" },
      { market: "apps-in-toss", enabled: true, locales: [], releaseChannel: "private" },
    ],
  });
  assert.equal(configRevisionPayloadSchema.safeParse(result.payload).success, true);
  assert.equal("projectBlueprint" in result.payload, false);
  assert.equal("localizations" in result.payload, false);
  assert.equal("complianceDrafts" in result.payload, false);
  assert.equal("assets" in result.payload, false);
});

test("기존 ACTIVE/DRAFT는 source 안전성 재평가 대상으로 보낸다", () => {
  const result = assessDesiredStateCandidate(candidate({
    configuredRevision: {
      id: "revision-1",
      revision: 3,
      status: "DRAFT",
      sourceObservation: null,
    },
  }));
  assert.deepEqual(result, {
    outcome: "SOURCE_RECONCILE",
    revisionId: "revision-1",
    revision: 3,
    revisionStatus: "DRAFT",
  });
});

test("ACTIVE revision은 semantic source가 current일 때만 이미 설정됨으로 판정한다", () => {
  const current = candidate();
  const configuredRevision = {
    id: "revision-1",
    revision: 3,
    status: "ACTIVE",
    sourceObservation: {
      appId: current.appId,
      sourceSha: current.observation!.sourceSha,
      sourceRef: current.observation!.sourceRef,
      payloadHash: current.observation!.payloadHash,
    },
  };
  assert.equal(assessDesiredStateCandidate(candidate({ configuredRevision })).outcome,
    "ALREADY_CONFIGURED");
  assert.equal(assessDesiredStateCandidate(candidate({
    configuredRevision: {
      ...configuredRevision,
      sourceObservation: {
        ...configuredRevision.sourceObservation,
        sourceSha: "c".repeat(40),
      },
    },
  })).outcome, "SOURCE_RECONCILE");
});

test("PAUSED와 DEPRECATED PRODUCT_APP도 중앙 DRAFT와 current config 판정에서 누락하지 않는다", () => {
  const current = candidate();
  const configuredRevision = {
    id: "revision-lifecycle",
    revision: 4,
    status: "ACTIVE",
    sourceObservation: {
      appId: current.appId,
      sourceSha: current.observation!.sourceSha,
      sourceRef: current.observation!.sourceRef,
      payloadHash: current.observation!.payloadHash,
    },
  };
  for (const status of ["PAUSED", "DEPRECATED"] as const) {
    assert.equal(assessDesiredStateCandidate(candidate({ status })).outcome, "READY", status);
    assert.deepEqual(
      assessDesiredStateCandidate(candidate({ status, configuredRevision })),
      {
        outcome: "ALREADY_CONFIGURED",
        revisionId: configuredRevision.id,
        revision: configuredRevision.revision,
        revisionStatus: configuredRevision.status,
      },
      status,
    );
  }
});

test("desired-state API는 safe source rebase v2 요청 계약만 받는다", () => {
  assert.equal(desiredStateBackfillSchema.safeParse({
    schemaVersion: 2,
    mode: "DRAFT_AND_SAFE_SOURCE_REBASE",
  }).success, true);
  assert.equal(desiredStateBackfillSchema.safeParse({
    schemaVersion: 1,
    mode: "DRAFT_ONLY",
  }).success, false);
});

test("배포 catch-up은 동일 SHA만 같은 key/hash로 replay하고 같은 UTC hour의 다른 SHA를 분리한다", () => {
  const now = new Date("2026-08-29T03:45:00.000Z");
  const first = desiredStateBackfillAdminInvocation({
    trigger: "deploy-catch-up",
    sourceSha: SHA,
    now,
  });
  const retry = desiredStateBackfillAdminInvocation({
    trigger: "deploy-catch-up",
    sourceSha: SHA,
    now: new Date("2026-08-29T03:59:59.999Z"),
  });
  const nextDeploy = desiredStateBackfillAdminInvocation({
    trigger: "deploy-catch-up",
    sourceSha: "b".repeat(40),
    now,
  });

  assert.deepEqual(retry, first);
  assert.equal(desiredStateBackfillRequestHash(retry), desiredStateBackfillRequestHash(first));
  assert.notEqual(nextDeploy.idempotencyKey, first.idempotencyKey);
  assert.notEqual(
    desiredStateBackfillRequestHash(nextDeploy),
    desiredStateBackfillRequestHash(first),
  );
  assert.match(first.idempotencyKey, new RegExp(`${SHA}$`));
});

test("hourly Cron occurrence는 deploy namespace와 분리되고 같은 hour에서만 replay한다", () => {
  const first = desiredStateBackfillAdminInvocation({
    trigger: "hourly-cron",
    sourceSha: null,
    now: new Date("2026-08-29T03:00:00.000Z"),
  });
  const sameHour = desiredStateBackfillAdminInvocation({
    trigger: "hourly-cron",
    sourceSha: null,
    now: new Date("2026-08-29T03:59:59.999Z"),
  });
  const nextHour = desiredStateBackfillAdminInvocation({
    trigger: "hourly-cron",
    sourceSha: null,
    now: new Date("2026-08-29T04:00:00.000Z"),
  });
  const deploy = desiredStateBackfillAdminInvocation({
    trigger: "deploy-catch-up",
    sourceSha: SHA,
    now: new Date("2026-08-29T03:00:00.000Z"),
  });

  assert.equal(sameHour.idempotencyKey, first.idempotencyKey);
  assert.notEqual(nextHour.idempotencyKey, first.idempotencyKey);
  assert.notEqual(deploy.idempotencyKey, first.idempotencyKey);
  assert.equal(first.trigger, "HOURLY_CRON");
  assert.equal(first.sourceSha, null);
});

test("admin trigger는 exact lowercase SHA와 trigger/source 조합을 fail-closed로 검증한다", () => {
  const now = new Date("2026-08-29T03:00:00.000Z");
  const invalid = [
    { trigger: "deploy-catch-up", sourceSha: "a".repeat(39), code: "SOURCE_SHA_INVALID" },
    { trigger: "deploy-catch-up", sourceSha: "A".repeat(40), code: "SOURCE_SHA_INVALID" },
    { trigger: "hourly-cron", sourceSha: SHA, code: "SOURCE_SHA_NOT_ALLOWED" },
    { trigger: null, sourceSha: null, code: "BACKFILL_TRIGGER_INVALID" },
  ] as const;
  for (const entry of invalid) {
    assert.throws(
      () => desiredStateBackfillAdminInvocation({ ...entry, now }),
      (error) => error instanceof ControlPlaneError && error.code === entry.code,
    );
  }
});

test("stored replay는 actor, trigger, source SHA와 전체 request hash가 모두 같아야 한다", () => {
  const requested = desiredStateBackfillAdminInvocation({
    trigger: "deploy-catch-up",
    sourceSha: SHA,
    now: new Date("2026-08-29T03:00:00.000Z"),
  });
  const requestHash = desiredStateBackfillRequestHash(requested);
  const stored = {
    actor: requested.actor,
    requestHash,
    trigger: requested.trigger,
    sourceSha: requested.sourceSha,
  };
  assert.doesNotThrow(() => assertDesiredStateBackfillReplay({
    stored,
    requested: { ...requested, requestHash },
  }));
  for (const mismatch of [
    { ...stored, actor: "deploy:other" },
    { ...stored, requestHash: "f".repeat(64) },
    { ...stored, trigger: "HOURLY_CRON" },
    { ...stored, sourceSha: "b".repeat(40) },
  ]) {
    assert.throws(
      () => assertDesiredStateBackfillReplay({
        stored: mismatch,
        requested: { ...requested, requestHash },
      }),
      (error) => error instanceof ControlPlaneError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  }
});

test("backfill은 source-only 안전 activation만 호출하고 provider mutation은 호출하지 않는다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/control-plane/desired-state-backfill.ts"), "utf8");
  assert.match(source, /createDraftRevisionInTransaction/);
  assert.match(source, /autoRebaseCurrentActiveConfigSource\s*\(/);
  assert.doesNotMatch(source, /providerExecution|octokit|pulls\.create|repos\.update/);
  assert.match(source, /sourceObservationId/);
  assert.match(source, /FOR UPDATE/);
});

test("provider adapter ID는 provisioner canonical contract 하나만 사용한다", () => {
  assert.equal(PROVIDER_ADAPTER_IDS.FIREBASE_PROVISIONER, "firebase-provisioner-v1");
  assert.equal(PROVIDER_ADAPTER_IDS.WORKSPACE_PROVISIONER, "workspace-provisioner-v1");
  const docs = readFileSync(join(process.cwd(), "docs/FLEET_CONTROL_PLANE.md"), "utf8");
  assert.doesNotMatch(docs, /firebase-admin-v1|workspace-admin-v1/);
});

test("migration과 API가 additive provenance, durable idempotency, scheduler 경계를 고정한다", () => {
  const migration = readFileSync(join(
    process.cwd(),
    "prisma/migrations/20260829020000_p5_discovery_desired_state_backfill/migration.sql",
  ), "utf8");
  assert.match(migration, /ADD COLUMN `classification`/);
  assert.match(migration, /ADD COLUMN `discoveryContractVersion`/);
  assert.match(migration, /ADD COLUMN `contractVersion`/);
  assert.match(migration, /sourceObservationId/);
  assert.match(migration, /idempotencyKey/);
  assert.match(migration, /cp_config_revision_source_observation_fkey/);
  assert.doesNotMatch(
    migration.replace(/ON UPDATE RESTRICT/gi, ""),
    /\b(?:DROP|MODIFY|CHANGE|DELETE\s+FROM|UPDATE\s+)\b/i,
  );

  const sourceBindingMigration = readFileSync(join(
    process.cwd(),
    "prisma/migrations/20260829030000_desired_state_backfill_source_binding/migration.sql",
  ), "utf8");
  assert.match(sourceBindingMigration, /ADD COLUMN `trigger`/);
  assert.match(sourceBindingMigration, /ADD COLUMN `sourceSha` CHAR\(40\) NULL/);
  assert.match(sourceBindingMigration, /DEPLOY_CATCH_UP/);
  assert.doesNotMatch(
    sourceBindingMigration,
    /\b(?:DROP|MODIFY|CHANGE|DELETE\s+FROM|UPDATE\s+)\b/i,
  );
  assert.equal(DESIRED_STATE_BACKFILL_CONTRACT_VERSION, "desired-state-safe-source-rebase/v3");

  const api = readFileSync(join(
    process.cwd(),
    "src/app/api/control-plane/desired-state-backfill/route.ts",
  ), "utf8");
  assert.match(api, /authenticateInternalRequest/);
  assert.match(api, /requireIdempotencyKey/);
  assert.match(api, /desiredStateBackfillSchema\.parse/);

  const scheduler = readFileSync(join(process.cwd(), "k8s/scheduler-cronjobs.yaml"), "utf8");
  assert.match(scheduler, /name: backoffice-desired-state-backfill/);
  assert.match(scheduler, /api\/admin\/desired-state\/backfill/);
  assert.match(scheduler, /x-seorilabs-backfill-trigger: hourly-cron/);

  const adminRoute = readFileSync(join(
    process.cwd(),
    "src/app/api/admin/desired-state/backfill/route.ts",
  ), "utf8");
  assert.match(adminRoute, /x-seorilabs-backfill-trigger/);
  assert.match(adminRoute, /x-seorilabs-source-sha/);
  assert.match(adminRoute, /desiredStateBackfillReadbackHeaders/);
});

test("discovery semantic replay는 현재 분류 계약의 run만 재사용한다", () => {
  const source = readFileSync(join(
    process.cwd(),
    "src/lib/control-plane/repository-registration.ts",
  ), "utf8");
  assert.match(source, /contractVersion:\s*REPOSITORY_DISCOVERY_CONTRACT_VERSION/);
});
