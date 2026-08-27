import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  configRevisionPayloadSchema,
  discoveryObservationSchema,
  providerObservationSchema,
  reauthPublicReason,
  reauthRequestSchema,
} from "@/lib/control-plane/contracts";
import {
  assertConfigRevisionPayload,
  assertIdempotentRequestHash,
  ControlPlaneError,
  discoveryObservationRequestHash,
  providerObservationRequestHash,
  resolvedWorkflowCaller,
} from "@/lib/control-plane/service";
import { redactFleetError, redactFleetJson } from "@/lib/control-plane/fleet-view";

test("비민감 Config payload는 UI와 API 공용 validator를 통과한다", () => {
  const payload = {
    schemaVersion: 1,
    markets: [{
      market: "google-play",
      enabled: true,
      locales: ["ko-KR", "en-US"],
      releaseChannel: "internal",
    }],
    localizations: [{ locale: "ko-KR", displayName: "테스트 앱" }],
    assets: [{ kind: "icon", objectKey: "assets/icon-r2", checksum: "a".repeat(64) }],
    build: { targetSdk: 35, workflowBundleSha: "b".repeat(40) },
    support: { privacyPolicyUrl: "https://example.com/privacy" },
  };
  assert.deepEqual(configRevisionPayloadSchema.parse(payload), payload);
  assert.doesNotThrow(() => assertConfigRevisionPayload(payload));
});

test("strict allowlist 밖의 공개 배포·심사 alias는 DRAFT 생성과 activation 모두 fail-closed한다", () => {
  const bypasses = [
    { schemaVersion: 1, markets: [], track: "production" },
    { schemaVersion: 1, markets: [], visibility: "public" },
    { schemaVersion: 1, markets: [], review: { action: "submit" } },
    { schemaVersion: 1, markets: [], goLive: true },
  ];
  for (const payload of bypasses) {
    assert.equal(configRevisionPayloadSchema.safeParse(payload).success, false);
    assert.throws(
      () => assertConfigRevisionPayload(payload),
      (error) => error instanceof ControlPlaneError
        && error.code === "HUMAN_APPROVAL_REQUIRED"
        && error.status === 403,
    );
  }
});

test("Config 계약은 market·locale 중복, channel 조합, SDK 역전을 거부한다", () => {
  const base = { schemaVersion: 1 as const, markets: [] };
  const invalidPayloads = [
    {
      ...base,
      markets: [
        { market: "google-play", enabled: true, locales: ["ko-KR"], releaseChannel: "internal" },
        { market: "google-play", enabled: false, locales: [] },
      ],
    },
    {
      ...base,
      markets: [{ market: "google-play", enabled: true, locales: ["ko-KR", "ko-KR"], releaseChannel: "internal" }],
    },
    {
      ...base,
      markets: [{ market: "app-store", enabled: true, locales: [], releaseChannel: "internal" }],
    },
    {
      ...base,
      localizations: [{ locale: "ko-KR", displayName: "첫 이름" }, { locale: "ko-KR", displayName: "둘째 이름" }],
    },
    { ...base, build: { minSdk: 36, targetSdk: 35 } },
  ];
  for (const payload of invalidPayloads) {
    assert.equal(configRevisionPayloadSchema.safeParse(payload).success, false);
  }
});

test("ReauthRequest는 정확한 HTTPS origin과 공개 필드만 허용한다", () => {
  const valid = {
    repoId: "123",
    provider: "google-play",
    origin: "https://play.google.com",
    publicAccountId: "publisher-team-1",
    capability: "build.status.read",
    gate: "PASSKEY",
  };
  assert.equal(reauthRequestSchema.safeParse(valid).success, true);
  assert.equal(reauthRequestSchema.safeParse({ ...valid, origin: "http://play.google.com" }).success, false);
  assert.equal(reauthRequestSchema.safeParse({ ...valid, origin: "https://play.google.com/login" }).success, false);
  assert.equal(reauthRequestSchema.safeParse({ ...valid, password: "never" }).success, false);
  assert.equal(reauthRequestSchema.safeParse({ ...valid, totp: "000000" }).success, false);
  assert.equal(reauthRequestSchema.safeParse({ ...valid, cookie: "never" }).success, false);
  assert.equal(reauthRequestSchema.safeParse({ ...valid, reason: "provider DOM text" }).success, false);
  assert.equal(reauthPublicReason("PASSKEY"), "Passkey 인증은 사람이 trusted local UI에서 완료해야 합니다.");
});

test("workflow caller는 exact source observation의 strict projection만 허용한다", () => {
  const workflowCaller = { profile: "react-native", packageManager: "pnpm", workingDirectory: "apps/mobile" };
  assert.equal(discoveryObservationSchema.safeParse({
    repoId: "123",
    sourceSha: "a".repeat(40),
    sourceRef: "refs/heads/main",
    observedAt: "2026-08-27T00:00:00.000Z",
    workflowCaller,
    payload: {},
    buildTargets: [],
  }).success, true);
  assert.deepEqual(resolvedWorkflowCaller({
    profile: workflowCaller.profile,
    packageManager: workflowCaller.packageManager,
    workingDirectory: workflowCaller.workingDirectory,
  }), workflowCaller);
  assert.throws(
    () => resolvedWorkflowCaller({ profile: null, packageManager: null, workingDirectory: null }),
    (error) => error instanceof ControlPlaneError && error.code === "NO_WORKFLOW_CALLER_FOR_SHA",
  );
  assert.throws(
    () => resolvedWorkflowCaller({ profile: "react-native", packageManager: "pnpm", workingDirectory: "../mobile" }),
    (error) => error instanceof ControlPlaneError && error.code === "NO_WORKFLOW_CALLER_FOR_SHA",
  );
});

test("observation validator는 중복 targetKey와 provider unknown field를 fail-closed한다", () => {
  const discovery = {
    repoId: "123",
    sourceSha: "a".repeat(40),
    observedAt: "2026-08-27T00:00:00.000Z",
    workflowCaller: { profile: "godot", packageManager: "npm", workingDirectory: "." },
    payload: {},
    buildTargets: [
      { targetKey: "android", stack: "godot" },
      { targetKey: "android", stack: "godot", market: "google-play" },
    ],
  };
  assert.equal(discoveryObservationSchema.safeParse(discovery).success, false);

  const provider = {
    repoId: "123",
    provider: "google-play",
    resourceType: "app",
    resourceId: "com.example.app",
    observedAt: "2026-08-27T00:00:00.000Z",
    payload: {},
  };
  assert.equal(providerObservationSchema.safeParse(provider).success, true);
  assert.equal(providerObservationSchema.safeParse({ ...provider, providerWrite: true }).success, false);
  assert.equal(providerObservationSchema.safeParse({
    ...provider,
    externalBinding: { bindingType: "publisher", externalId: "team-1", secret: "never" },
  }).success, false);
});

test("observation idempotency hash는 buildTarget과 externalBinding 전체를 결합한다", () => {
  const discovery = {
    repoId: 123n,
    sourceSha: "a".repeat(40),
    sourceRef: "refs/heads/main",
    observedAt: new Date("2026-08-27T00:00:00.000Z"),
    observedBy: "worker-1",
    workflowCaller: { profile: "react-native" as const, packageManager: "pnpm" as const, workingDirectory: "." },
    payload: {},
    buildTargets: [{ targetKey: "android", stack: "react-native", packageId: "com.example.one" }],
  };
  const discoveryHash = discoveryObservationRequestHash(discovery);
  const changedBuildTargetHash = discoveryObservationRequestHash({
    ...discovery,
    buildTargets: [{ ...discovery.buildTargets[0], packageId: "com.example.two" }],
  });
  assert.notEqual(discoveryHash, changedBuildTargetHash);
  assert.throws(
    () => assertIdempotentRequestHash(discoveryHash, changedBuildTargetHash),
    (error) => error instanceof ControlPlaneError && error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409,
  );

  const provider = {
    repoId: 123n,
    provider: "google-play",
    resourceType: "app",
    resourceId: "com.example.one",
    observedAt: new Date("2026-08-27T00:00:00.000Z"),
    observedBy: "worker-1",
    payload: {},
    externalBinding: { bindingType: "publisher", externalId: "team-1", publicIdentity: "publisher-1" },
  };
  const providerHash = providerObservationRequestHash(provider);
  const changedBindingHash = providerObservationRequestHash({
    ...provider,
    externalBinding: { ...provider.externalBinding, publicIdentity: "publisher-2" },
  });
  assert.notEqual(providerHash, changedBindingHash);
  assert.throws(
    () => assertIdempotentRequestHash(providerHash, changedBindingHash),
    (error) => error instanceof ControlPlaneError && error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409,
  );
});

test("Fleet run 오류를 화면에 내보내기 전에 credential 후보를 제거한다", () => {
  const redacted = redactFleetError(
    "failed Bearer abc.def.ghi password=hunter2 totp:123456 cookie=session-value "
      + "a".repeat(90),
  );
  assert.doesNotMatch(redacted ?? "", /abc\.def|hunter2|123456|session-value/);
  assert.match(redacted ?? "", /\[REDACTED\]/);
  assert.deepEqual(redactFleetJson({
    publicAccountId: "team-1",
    nested: { apiKey: "never", note: "Bearer token-value" },
  }), {
    publicAccountId: "team-1",
    nested: { apiKey: "[REDACTED]", note: "Bearer [REDACTED]" },
  });
});

test("Prisma 모델과 UI에는 raw authentication secret 필드가 없다", () => {
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const migration = readFileSync(
    join(
      process.cwd(),
      "prisma/migration-archive/legacy-v1/36_fleet_operations_ui/migration.sql",
    ),
    "utf8",
  );
  const editor = readFileSync(
    join(process.cwd(), "src/components/fleet/FleetConfigEditor.tsx"),
    "utf8",
  );
  const actions = readFileSync(
    join(process.cwd(), "src/lib/actions/fleet-control-plane.ts"),
    "utf8",
  );
  const service = readFileSync(
    join(process.cwd(), "src/lib/control-plane/service.ts"),
    "utf8",
  );
  const reauthModel = schema.match(/model ReauthRequest \{[\s\S]*?\n\}/)?.[0] ?? "";
  const credentialModel = schema.match(/model CredentialBinding \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.doesNotMatch(reauthModel, /^\s*(password|totp|cookie|recoveryCode|secret|reason)\s+/m);
  assert.doesNotMatch(credentialModel, /^\s*(value|secret|privateKey|password)\s+/m);
  assert.doesNotMatch(editor, /type=["']password["']/);
  assert.match(actions, /requirePlatformReadAccess\(\)/);
  assert.match(actions, /requirePlatformWriteAccess\(app\.slug\)/);
  assert.match(actions, /uiRequestIdSchema\.parse\(input\.requestId\)/);
  assert.match(actions, /markReauthTrustedLocalPendingFromHumanUi/);
  assert.match(service, /control-plane\.reauth\.trusted-local-pending\.human-ui/);
  assert.match(service, /transitionSource: "BACKOFFICE_HUMAN_UI"/);
  assert.doesNotMatch(actions, /randomUUID/);
  assert.equal(existsSync(join(
    process.cwd(),
    "src/app/api/control-plane/reauth-requests/trusted-local-pending/route.ts",
  )), false);
  assert.match(schema, /gate\s+ReauthGate/);
  assert.doesNotMatch(migration, /`reason`/);
  assert.match(migration, /UNIQUE INDEX `control_plane_reauth_request_idempotencyKey_key`/);
  assert.match(migration, /UNIQUE INDEX `control_plane_reauth_request_trustedLocalIdempotencyKey_key`/);
});
