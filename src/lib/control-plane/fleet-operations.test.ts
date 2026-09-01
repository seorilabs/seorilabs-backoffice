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
  assertObservationTime,
  assertIdempotentRequestHash,
  ControlPlaneError,
  discoveryObservationRequestHash,
  providerObservationRequestHash,
  resolvedWorkflowCaller,
} from "@/lib/control-plane/service";
import { redactFleetError, redactFleetJson } from "@/lib/control-plane/fleet-view";

const dependencyAuditException = {
  schemaVersion: 1 as const,
  repositoryId: "1250442131" as const,
  fullName: "seorilabs/happy-farm" as const,
  bindings: [
    {
      actionClass: "STATIC_CHECK" as const,
      sourceSha: "3d8c7f96eb6bb9ef47b3d5485cb5faf1408373a2",
      lockfileSha256: "sha256:bb7c039ab9bb3b0deb3755e124a2f248f44b09c984cc12e1a5450686e18bd3c5",
    },
    {
      actionClass: "ANDROID_BUILD_ONLY" as const,
      sourceSha: "376c31350558c3ac4ed88907c4a35b0e443b5cd7",
      lockfileSha256: "sha256:bb0676484da96a39896ceefa3f74b047eab4705dc3f81c87a31ffb88fdd0b1a8",
    },
  ],
  expiresAt: "2026-09-13T00:00:00Z",
  reason: "공식 패치 대기 중인 build-time dependency advisory 3건",
  advisories: [
    { ghsa: "GHSA-2p57-rm9w-gvfp", module: "ip", severity: "high" as const, versions: ["1.1.9"] },
    {
      ghsa: "GHSA-5p2g-fcmc-qvqq",
      module: "image-size",
      severity: "high" as const,
      versions: ["0.6.3", "1.2.1"],
    },
    {
      ghsa: "GHSA-w3rx-r6r6-pgpr",
      module: "image-size",
      severity: "high" as const,
      versions: ["0.6.3", "1.2.1"],
    },
  ],
};

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

test("dependency audit 예외는 Happy Farm의 두 build-only source와 정렬된 high 3건만 허용한다", () => {
  const payload = {
    schemaVersion: 1 as const,
    markets: [],
    build: { dependencyAuditException },
  };
  assert.deepEqual(configRevisionPayloadSchema.parse(payload), payload);
  assert.doesNotThrow(() => assertConfigRevisionPayload(payload));

  const invalidExceptions = [
    { ...dependencyAuditException, repositoryId: "7001" },
    { ...dependencyAuditException, fullName: "seorilabs/other-app" },
    { ...dependencyAuditException, bindings: [...dependencyAuditException.bindings].reverse() },
    { ...dependencyAuditException, expiresAt: "2026-09-13" },
    { ...dependencyAuditException, reason: "token=not-public-credential-value" },
    { ...dependencyAuditException, actionClass: "BUILD_ONLY" },
    {
      ...dependencyAuditException,
      advisories: [...dependencyAuditException.advisories].reverse(),
    },
    {
      ...dependencyAuditException,
      advisories: dependencyAuditException.advisories.map((advisory, index) => index === 1
        ? { ...advisory, versions: ["1.2.1", "0.6.3"] }
        : advisory),
    },
    {
      ...dependencyAuditException,
      advisories: dependencyAuditException.advisories.slice(0, 2),
    },
  ];
  for (const exception of invalidExceptions) {
    assert.equal(configRevisionPayloadSchema.safeParse({
      schemaVersion: 1,
      markets: [],
      build: { dependencyAuditException: exception },
    }).success, false);
  }
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

test("Config의 공개 support URL은 credential userinfo와 query token을 저장하지 않는다", () => {
  const base = { schemaVersion: 1 as const, markets: [] };
  for (const privacyPolicyUrl of [
    "https://user:password@example.com/privacy",
    "https://example.com/privacy?token=should-not-persist",
    "https://example.com/privacy#secret-fragment",
  ]) {
    assert.equal(configRevisionPayloadSchema.safeParse({
      ...base,
      support: { privacyPolicyUrl },
    }).success, false);
  }
  assert.equal(configRevisionPayloadSchema.safeParse({
    ...base,
    support: { privacyPolicyUrl: "https://example.com/privacy" },
  }).success, true);
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

test("Config 계약은 canonical BCP 47 script·region locale을 허용한다", () => {
  const valid = configRevisionPayloadSchema.safeParse({
    schemaVersion: 1,
    markets: [{
      market: "google-play",
      enabled: true,
      locales: ["zh-Hans", "zh-Hant", "sr-Latn-RS", "es-419"],
      releaseChannel: "internal",
    }],
  });
  assert.equal(valid.success, true);

  for (const invalidLocale of ["zh_hans", "ZH-HANS", "en-us", "x-private"]) {
    assert.equal(configRevisionPayloadSchema.safeParse({
      schemaVersion: 1,
      markets: [{
        market: "google-play",
        enabled: true,
        locales: [invalidLocale],
        releaseChannel: "internal",
      }],
    }).success, false);
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
  assert.deepEqual(resolvedWorkflowCaller({
    profile: "godot",
    packageManager: null,
    workingDirectory: ".",
  }), {
    profile: "godot",
    packageManager: null,
    workingDirectory: ".",
  });
  assert.deepEqual(resolvedWorkflowCaller({
    profile: "capacitor",
    packageManager: "pnpm",
    workingDirectory: "app",
  }), {
    profile: "capacitor",
    packageManager: "pnpm",
    workingDirectory: "app",
  });
  assert.deepEqual(resolvedWorkflowCaller({
    profile: "ait-web",
    packageManager: "npm",
    workingDirectory: "apps-in-toss",
  }), {
    profile: "ait-web",
    packageManager: "npm",
    workingDirectory: "apps-in-toss",
  });
  assert.throws(
    () => resolvedWorkflowCaller({ profile: "godot", packageManager: "npm", workingDirectory: "." }),
    (error) => error instanceof ControlPlaneError && error.code === "NO_WORKFLOW_CALLER_FOR_SHA",
  );
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
    workflowCaller: { profile: "godot", packageManager: null, workingDirectory: "." },
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

test("미래 시각 observation은 latest event-time pointer를 오염시키기 전에 거부한다", () => {
  const receivedAt = new Date("2026-08-28T00:00:00.000Z");
  assert.doesNotThrow(() => assertObservationTime(
    new Date("2026-08-28T00:05:00.000Z"),
    receivedAt,
  ));
  assert.throws(
    () => assertObservationTime(new Date("2099-01-01T00:00:00.000Z"), receivedAt),
    (error) => error instanceof ControlPlaneError
      && error.code === "OBSERVED_AT_FUTURE"
      && error.status === 400,
  );
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
  const fleetPage = readFileSync(
    join(process.cwd(), "src/app/(app)/apps/[id]/fleet/page.tsx"),
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
  assert.match(editor, /initialPayloadSource === "LEGACY_SHADOW"/);
  assert.match(fleetPage, /latestShadowDraft[\s\S]*legacyConfigImport\?\.status\?\.startsWith\("DRAFT_CREATED"\)/);
  assert.match(fleetPage, /configRevisionPayloadSchema\.safeParse\(latestShadowDraft\?\.payload\)/);
  assert.match(actions, /requirePlatformReadAccess\(\)/);
  assert.match(actions, /requirePlatformWriteAccess\(app\.slug\)/);
  assert.match(actions, /uiRequestIdSchema\.parse\(input\.requestId\)/);
  assert.match(actions, /legacyShadowImportRequestSchema\.parse/);
  assert.match(actions, /recordLegacyShadowImport/);
  assert.match(actions, /observedBy: actor\.login/);
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
