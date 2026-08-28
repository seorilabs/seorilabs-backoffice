import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assessDesiredStateCandidate,
  type DesiredStateCandidate,
} from "@/lib/control-plane/desired-state-backfill";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { PROVIDER_ADAPTER_IDS } from "@/lib/control-plane/provider-adapters";
import { REPOSITORY_DISCOVERY_CONTRACT_VERSION } from "@/lib/control-plane/repository-discovery";

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

test("기존 ACTIVE/DRAFT가 있으면 새 revision 대신 멱등 readback을 반환한다", () => {
  const result = assessDesiredStateCandidate(candidate({
    configuredRevision: { id: "revision-1", revision: 3, status: "DRAFT" },
  }));
  assert.deepEqual(result, {
    outcome: "ALREADY_CONFIGURED",
    revisionId: "revision-1",
    revision: 3,
    revisionStatus: "DRAFT",
  });
});

test("backfill 실행 경계는 DRAFT 전용이고 activation/provider mutation을 호출하지 않는다", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/control-plane/desired-state-backfill.ts"), "utf8");
  assert.match(source, /createDraftRevisionInTransaction/);
  assert.doesNotMatch(source, /activateConfigRevision\s*\(/);
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
});

test("discovery semantic replay는 현재 분류 계약의 run만 재사용한다", () => {
  const source = readFileSync(join(
    process.cwd(),
    "src/lib/control-plane/repository-registration.ts",
  ), "utf8");
  assert.match(source, /contractVersion:\s*REPOSITORY_DISCOVERY_CONTRACT_VERSION/);
});
