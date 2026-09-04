import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  configRevisionPayloadSchema,
  projectBlueprintSchema,
  providerReadbackPayloadSchema,
  type ProjectBlueprint,
} from "@/lib/control-plane/contracts";
import { normalizeMarketReadback } from "@/lib/control-plane/market-adapter";
import {
  blueprintResourceState,
  compileBlueprintResources,
  evaluateProjectBlueprint,
} from "@/lib/control-plane/project-blueprint";
import { releaseCandidateStatus } from "@/lib/control-plane/release-ledger";
import { ControlPlaneError } from "@/lib/control-plane/service";

const checksum = "a".repeat(64);
const sourceSha = "b".repeat(40);

function blueprint(): ProjectBlueprint {
  return {
    schemaVersion: 2,
    organizationId: "123456789",
    folderId: "234567890",
    billingAccountId: "ABCDEF-123456-789ABC",
    project: { projectId: "sample-prod", projectNumber: "345678901", region: "asia-northeast3" },
    apis: ["firebase.googleapis.com", "firestore.googleapis.com"],
    iam: [{
      role: "roles/firebase.admin",
      logicalPrincipalId: "shared/gcp/firebase-automation",
      publicIdentity: "serviceAccount:firebase-automation@example.iam.gserviceaccount.com",
    }],
    budget: { currencyCode: "KRW", monthlyAmount: 100_000, alertThresholds: [0.5, 0.9, 1] },
    firebase: {
      authProviders: ["anonymous"],
      appCheck: {
        managementMode: "MONITOR",
        registrations: [
          { platform: "ANDROID", publicAppId: "1:1:android:sample", status: "REGISTERED", provider: "PLAY_INTEGRITY" },
          { platform: "IOS", publicAppId: "1:1:ios:sample", status: "REGISTERED", provider: "APP_ATTEST" },
        ],
        apiEnforcement: [
          { api: "AUTHENTICATION", state: "OFF" },
          { api: "FIRESTORE", state: "OFF" },
          { api: "STORAGE", state: "OFF" },
          { api: "FUNCTIONS", state: "OFF" },
        ],
      },
      firestoreRulesChecksum: checksum,
      firestoreIndexesChecksum: checksum,
      storageRulesChecksum: checksum,
      functions: { region: "asia-northeast3", runtime: "nodejs24" },
      apps: [
        { platform: "ANDROID", publicAppId: "1:1:android:sample", packageId: "com.seorilabs.sample" },
        { platform: "IOS", publicAppId: "1:1:ios:sample", bundleId: "com.seorilabs.sample" },
        { platform: "AIT", aitAppName: "sample" },
      ],
    },
    analytics: {
      ga4PropertyId: "123456789",
      bigQueryProjectId: "sample-prod",
      datasetId: "analytics_123456789",
      location: "ASIA-NORTHEAST3",
    },
    workspace: {
      groups: [{ email: "sample-operators@seorilabs.com", role: "OPERATOR" }],
      domainWideDelegation: [{ publicClientId: "456789012", scopes: ["https://www.googleapis.com/auth/admin.directory.group.readonly"] }],
    },
    provisioners: {
      gcp: "shared/gcp/provisioner-session",
      firebase: "shared/gcp/firebase-automation",
      workspace: "shared/google-workspace/provisioner",
    },
  };
}

test("ProjectBlueprint는 비밀 필드와 앱별 공용 provisioner 대체를 fail-closed한다", () => {
  assert.equal(projectBlueprintSchema.safeParse({ ...blueprint(), apiKey: "forbidden" }).success, false);
  assert.equal(projectBlueprintSchema.safeParse({
    ...blueprint(),
    provisioners: { ...blueprint().provisioners, gcp: "app/sample/gcp/provisioner" },
  }).success, false);
});

test("ConfigRevision은 market별 localization/asset과 DRAFT compliance만 허용한다", () => {
  const parsed = configRevisionPayloadSchema.parse({
    schemaVersion: 1,
    markets: [{ market: "google-play", enabled: true, locales: ["ko-KR"], releaseChannel: "internal" }],
    localizations: [{ market: "google-play", locale: "ko-KR", displayName: "샘플" }],
    assets: [{ market: "google-play", kind: "icon", objectKey: "apps/sample/icon", checksum }],
    complianceDrafts: [{ market: "google-play", declaration: "data-safety", state: "DRAFT", draft: true }],
    projectBlueprint: blueprint(),
  });
  assert.equal(parsed.projectBlueprint?.project.projectId, "sample-prod");
  assert.equal(configRevisionPayloadSchema.safeParse({
    ...parsed,
    complianceDrafts: [{ ...parsed.complianceDrafts?.[0], state: "APPROVED" }],
  }).success, false);
});

test("ProjectBlueprint resource plan은 입력 배열 순서가 달라도 결정적이다", () => {
  const left = compileBlueprintResources(blueprint());
  const shuffled = blueprint();
  shuffled.apis.reverse();
  shuffled.firebase.apps.reverse();
  shuffled.firebase.appCheck.registrations.reverse();
  shuffled.firebase.appCheck.apiEnforcement.reverse();
  assert.deepEqual(compileBlueprintResources(shuffled), left);
  assert.ok(left.some((item) => item.provider === "firebase" && item.resourceType === "app-registration"));
});

test("Functions와 Workspace 미사용 앱은 가짜 리소스나 provisioner를 요구하지 않는다", () => {
  const minimal = blueprint();
  delete minimal.firebase.functions;
  delete minimal.workspace;
  delete minimal.provisioners.workspace;
  minimal.firebase.appCheck.apiEnforcement = minimal.firebase.appCheck.apiEnforcement.map((entry) => (
    entry.api === "FUNCTIONS" ? { ...entry, state: "NOT_APPLICABLE" } : entry
  ));
  const resources = compileBlueprintResources(minimal);
  assert.equal(resources.some((item) => item.resourceType === "functions"), false);
  assert.equal(resources.some((item) => item.provider === "google-workspace"), false);
  const plan = evaluateProjectBlueprint({
    repoId: 1n,
    sourceSha,
    configRevision: 1,
    blueprint: minimal,
    observations: [],
    credentialBindings: [
      { logicalCredentialId: "shared/gcp/provisioner-session", capability: "gcp-project-provision", status: "ACTIVE" },
      { logicalCredentialId: "shared/gcp/firebase-automation", capability: "firebase-provision", status: "ACTIVE" },
    ],
  });
  assert.deepEqual(plan.credentialChecks.map((entry) => entry.provisioner), ["gcp", "firebase"]);
});

test("App Check는 Firebase 앱별 공개 ID와 등록 상태를 exact하게 요구한다", () => {
  const missingProvider = blueprint();
  missingProvider.firebase.appCheck.registrations[0] = {
    platform: "ANDROID",
    publicAppId: "1:1:android:sample",
    status: "REGISTERED",
  };
  assert.equal(projectBlueprintSchema.safeParse(missingProvider).success, false);

  const wrongApp = blueprint();
  wrongApp.firebase.appCheck.registrations[0].publicAppId = "1:1:android:other";
  assert.equal(projectBlueprintSchema.safeParse(wrongApp).success, false);
});

test("IAM visibility 부족은 ABSENT로 오판하지 않는다", () => {
  const desired = compileBlueprintResources(blueprint())[0];
  const forbidden = {
    provider: desired.provider,
    resourceType: desired.resourceType,
    resourceId: desired.resourceId,
    observedAt: new Date(),
    payload: { schemaVersion: 1, visibility: "FORBIDDEN", state: "UNKNOWN", attributes: {} },
  };
  assert.equal(blueprintResourceState(desired, forbidden), "FORBIDDEN");
  assert.equal(providerReadbackPayloadSchema.safeParse({
    schemaVersion: 1,
    visibility: "FORBIDDEN",
    state: "ABSENT",
    attributes: {},
  }).success, false);
});

test("shared identity가 없고 앱별 대체 credential만 있으면 plan을 차단한다", () => {
  const result = evaluateProjectBlueprint({
    repoId: 1n,
    sourceSha,
    configRevision: 1,
    blueprint: blueprint(),
    observations: [],
    credentialBindings: [{
      logicalCredentialId: "app/sample/gcp/provisioner",
      capability: "gcp-project-provision",
      status: "ACTIVE",
    }],
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.credentialChecks[0].state, "APP_SPECIFIC_SUBSTITUTE_REJECTED");
});

test("ProjectBlueprint는 모든 exact readback만 COMPLIANT이고 최신 drift를 우선한다", () => {
  const desired = compileBlueprintResources(blueprint());
  const observedAt = new Date("2026-08-29T00:00:00.000Z");
  const credentials = [
    ["shared/gcp/provisioner-session", "gcp-project-provision"],
    ["shared/gcp/firebase-automation", "firebase-provision"],
    ["shared/google-workspace/provisioner", "workspace-provision"],
  ].map(([logicalCredentialId, capability]) => ({
    logicalCredentialId,
    capability,
    status: "ACTIVE" as const,
  }));
  const observations = desired.map((resource) => ({
    provider: resource.provider,
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    observedAt,
    payload: {
      schemaVersion: 1,
      visibility: "VISIBLE",
      state: "PRESENT",
      ...(resource.publicIdentity ? { publicIdentity: resource.publicIdentity } : {}),
      attributes: { desiredHash: resource.desiredHash },
    },
  }));
  const compliant = evaluateProjectBlueprint({
    repoId: 1n,
    sourceSha,
    configRevision: 1,
    blueprint: blueprint(),
    observations,
    credentialBindings: credentials,
  });
  assert.equal(compliant.status, "COMPLIANT");

  const drifted = evaluateProjectBlueprint({
    repoId: 1n,
    sourceSha,
    configRevision: 1,
    blueprint: blueprint(),
    observations: [{
      ...observations[0],
      observedAt: new Date(observedAt.getTime() + 1),
      payload: {
        ...observations[0].payload,
        attributes: { desiredHash: "0".repeat(64) },
      },
    }, ...observations],
    credentialBindings: credentials,
  });
  assert.equal(drifted.status, "READY_TO_APPLY");
  assert.equal(drifted.resources.find((resource) => (
    resource.provider === desired[0].provider
    && resource.resourceType === desired[0].resourceType
    && resource.resourceId === desired[0].resourceId
  ))?.state, "DRIFT");
});

test("마켓 readback은 account/app/candidate identity가 다르면 원장에 넣지 않는다", () => {
  const readback = {
    schemaVersion: 1,
    market: "google-play",
    publicAccountId: "publisher-team",
    publicAppId: "com.seorilabs.sample",
    gate: "PROCESSING",
    state: "SUCCEEDED",
    sourceSha,
    configRevision: 2,
    artifactChecksum: checksum,
    observedAt: new Date(),
  };
  const normalized = normalizeMarketReadback(readback, {
    market: "google-play",
    publicAccountId: "publisher-team",
    publicAppId: "com.seorilabs.sample",
    sourceSha,
    configRevision: 2,
    artifactChecksum: checksum,
  });
  assert.equal(normalized.gate, "PROCESSING");
  assert.equal(normalized.status, "PASSED");
  assert.throws(
    () => normalizeMarketReadback(readback, {
      market: "google-play",
      publicAccountId: "other-team",
      publicAppId: "com.seorilabs.sample",
      sourceSha,
      configRevision: 2,
      artifactChecksum: checksum,
    }),
    (error) => error instanceof ControlPlaneError && error.code === "PROVIDER_IDENTITY_MISMATCH",
  );
});

test("release-candidate READY는 외부 upload/review/public과 분리된 6개 gate만 요구한다", () => {
  const now = new Date();
  const required = ["IMPLEMENTATION", "CI", "ARTIFACT", "RELEASE_ASSETS", "COMPLIANCE_DRAFT", "PROVIDER_SHELL"];
  const observations = required.map((gate, index) => ({
    gate,
    status: "PASSED" as const,
    observedAt: new Date(now.getTime() + index),
    createdAt: now,
    id: String(index),
  }));
  assert.equal(releaseCandidateStatus(observations), "READY");
  assert.equal(releaseCandidateStatus(observations.map((item) => (
    item.gate === "ARTIFACT" ? { ...item, status: "FAILED" as const } : item
  ))), "BLOCKED");
});

test("migration은 중앙 모델과 exact candidate binding을 DB에서 고정하고 secret 컬럼을 만들지 않는다", () => {
  const migration = readFileSync(join(
    process.cwd(),
    "prisma/migrations/20260828030000_project_blueprint_release_ledger/migration.sql",
  ), "utf8");
  const approvalBindingMigration = readFileSync(join(
    process.cwd(),
    "prisma/migrations/20260829010000_platform_fleet_approval_binding/migration.sql",
  ), "utf8");
  assert.match(migration, /CREATE TABLE `control_plane_project_blueprint`/);
  assert.match(migration, /CREATE TABLE `control_plane_market_profile`/);
  assert.match(migration, /CREATE TABLE `control_plane_fleet_lifecycle_state`/);
  assert.match(migration, /ADD COLUMN `workflowBundleSha` CHAR\(40\)/);
  assert.match(approvalBindingMigration, /ADD COLUMN `workflowBundleDigest` CHAR\(64\)/);
  assert.doesNotMatch(approvalBindingMigration, /\b(?:DROP|MODIFY|CHANGE|TRUNCATE|RENAME)\b/i);
  assert.doesNotMatch(migration, /`(?:password|totp|cookie|privateKey|apiKey)`/i);
});
