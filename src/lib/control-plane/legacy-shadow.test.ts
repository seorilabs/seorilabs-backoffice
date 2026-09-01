import assert from "node:assert/strict";
import test from "node:test";

import {
  compareLegacyShadow,
  transformLegacySources,
  type DraftableConfigRevisionPayload,
} from "@/lib/control-plane/legacy-shadow";
import {
  LEGACY_SOURCE_DEFINITIONS,
  matchesLegacySourcePath,
  type LegacySourceInput,
  type LegacySourceKind,
} from "@/lib/control-plane/legacy-sources";
import { resolveLegacyPlatformSourceVector } from "@/lib/control-plane/legacy-shadow-service";

const APP_SHA = "a".repeat(40);
const PLATFORM_SHA = "b".repeat(40);

function pathFor(sourceKind: LegacySourceKind): string {
  const definition = LEGACY_SOURCE_DEFINITIONS.find((item) => item.sourceKind === sourceKind);
  assert.ok(definition);
  return definition.sourceKind === "PLATFORM_APP_REGISTRY"
    ? "registry/apps/test-app.json"
    : definition.pathPattern;
}

function completeVector(present: Partial<Record<LegacySourceKind, unknown>>): LegacySourceInput[] {
  return LEGACY_SOURCE_DEFINITIONS.map((definition) => {
    const payload = present[definition.sourceKind];
    return {
      sourceKind: definition.sourceKind,
      repository: definition.repositoryScope === "APP" ? "seorilabs/test-app" : "seorilabs/platform",
      sourceSha: definition.repositoryScope === "APP" ? APP_SHA : PLATFORM_SHA,
      path: pathFor(definition.sourceKind),
      status: payload === undefined ? "ABSENT" : "PRESENT",
      ...(payload === undefined ? {} : {
        text: definition.format === "YAML"
          ? String(payload)
          : JSON.stringify(payload),
      }),
    };
  });
}

function safeGooglePayload(): Record<string, unknown> {
  return {
    defaultLanguage: "ko-KR",
    build: { targetSdk: 35, minSdk: 23 },
  };
}

test("legacy source allowlist는 exact path와 platform registry 한 항목만 허용한다", () => {
  assert.equal(matchesLegacySourcePath("GOOGLE_PLAY_CONFIG", "play-store/google-play.config.json"), true);
  assert.equal(matchesLegacySourcePath("GOOGLE_PLAY_CONFIG", "play-store/google-play.config.example.json"), false);
  assert.equal(matchesLegacySourcePath("PLATFORM_APP_REGISTRY", "registry/apps/test-app.json"), true);
  assert.equal(matchesLegacySourcePath("PLATFORM_APP_REGISTRY", "registry/apps/nested/test-app.json"), false);
  assert.equal(matchesLegacySourcePath("SEORILABS_APP_YAML", "../.seorilabs/app.yaml"), false);
});

test("legacy platform source는 app binding을 우선하고 없을 때 current producer registration만 사용한다", () => {
  const configured = { repoId: 123n, repoFullName: "seorilabs/platform" };
  const registration = {
    ...configured,
    status: "MANAGED" as const,
    archived: false,
    managementKind: "PLATFORM_PRODUCER" as const,
    classification: null,
    lastDefaultPushSha: PLATFORM_SHA,
    lastReconciledSha: PLATFORM_SHA,
  };
  assert.deepEqual(resolveLegacyPlatformSourceVector({
    configured,
    bindingSourceSha: "c".repeat(40),
    registration,
  }), { ...configured, sourceSha: "c".repeat(40) });
  assert.deepEqual(resolveLegacyPlatformSourceVector({
    configured,
    bindingSourceSha: null,
    registration,
  }), { ...configured, sourceSha: PLATFORM_SHA });
  assert.deepEqual(resolveLegacyPlatformSourceVector({
    configured,
    bindingSourceSha: null,
    registration: {
      ...registration,
      managementKind: "UNCLASSIFIED",
      classification: "PLATFORM_PRODUCER",
    },
  }), { ...configured, sourceSha: PLATFORM_SHA });
  assert.equal(resolveLegacyPlatformSourceVector({
    configured,
    bindingSourceSha: null,
    registration: { ...registration, lastDefaultPushSha: "d".repeat(40) },
  }), null);
  assert.equal(resolveLegacyPlatformSourceVector({
    configured,
    bindingSourceSha: null,
    registration: { ...registration, managementKind: "APP" },
  }), null);
});

test("runtime의 unknown source kind와 status도 allowlist 밖에서 fail-closed한다", () => {
  const unknown = [{
    sourceKind: "ARBITRARY_CONFIG",
    repository: "seorilabs/test-app",
    sourceSha: APP_SHA,
    path: "config.json",
    status: "PRESENT",
    text: "{}",
  }] as unknown as LegacySourceInput[];
  const unknownResult = transformLegacySources(unknown);
  assert.equal(unknownResult.status, "NEEDS_INPUT");
  assert.ok(unknownResult.reasons.some((reason) => reason.code === "SOURCE_KIND_NOT_ALLOWED"));

  const invalidStatus = completeVector({ GOOGLE_PLAY_CONFIG: safeGooglePayload() });
  invalidStatus[0] = { ...invalidStatus[0], status: "STALE" as LegacySourceInput["status"] };
  const invalidStatusResult = transformLegacySources(invalidStatus);
  assert.equal(invalidStatusResult.status, "NEEDS_INPUT");
  assert.ok(invalidStatusResult.reasons.some((reason) => reason.code === "SOURCE_STATUS_INVALID"));
});

test("완전한 source vector는 비민감 필드만 deterministic DRAFTABLE payload로 변환한다", () => {
  const sources = completeVector({ GOOGLE_PLAY_CONFIG: safeGooglePayload() });
  const first = transformLegacySources(sources);
  const second = transformLegacySources([...sources].reverse());
  assert.equal(first.status, "DRAFTABLE");
  assert.equal(second.status, "DRAFTABLE");
  assert.equal(first.inputDigest, second.inputDigest);
  assert.equal(first.status === "DRAFTABLE" && first.payloadDigest, second.status === "DRAFTABLE" && second.payloadDigest);
  if (first.status !== "DRAFTABLE") return;
  assert.deepEqual(first.payload.markets, [{
    market: "google-play",
    enabled: true,
    locales: ["ko-KR"],
    releaseChannel: "internal",
  }]);
  assert.equal(first.payload.assets, undefined);
  assert.equal(first.coverage.status, "COMPLETE");
  assert.equal(first.coverage.expected, 7);
  assert.equal(first.coverage.reported, 7);
});

test("secret-like key는 값 노출 없이 검토용 부분 DRAFT에서 제외한다", () => {
  const secret = "should-never-appear";
  const payload = { ...safeGooglePayload(), reviewPassword: secret };
  const result = transformLegacySources(completeVector({ GOOGLE_PLAY_CONFIG: payload }));
  assert.equal(result.status, "DRAFTABLE_WITH_INPUT");
  assert.ok(result.reasons.some((reason) => reason.code === "SECRET_LIKE_KEY"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  if (result.status !== "DRAFTABLE_WITH_INPUT") return;
  assert.deepEqual(result.payload.markets, [{
    market: "google-play",
    enabled: true,
    locales: ["ko-KR"],
    releaseChannel: "internal",
  }]);
  assert.deepEqual(result.payload.build, { minSdk: 23, targetSdk: 35 });
  const parity = compareLegacyShadow(result, result.payload);
  assert.equal(parity.status, "NEEDS_INPUT");
  assert.deepEqual(parity.diffs, [{ path: "$", code: "TRANSFORM_NEEDS_INPUT" }]);
});

test("자유 텍스트 필드의 canary 값은 검토용 부분 DRAFT나 결과에 남기지 않는다", () => {
  const canary = "CANARY_SECRET_VALUE_7f5a9c";
  const payload = safeGooglePayload();
  payload.storeListing = {
    appName: { "ko-KR": canary },
  };
  const result = transformLegacySources(completeVector({ GOOGLE_PLAY_CONFIG: payload }));
  assert.equal(result.status, "DRAFTABLE_WITH_INPUT");
  assert.ok(result.reasons.some((reason) => reason.code === "FREE_TEXT_REQUIRES_INPUT"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
});

test("SemVer suffix와 workflow SHA도 승인 원장 검증 전에는 자동 이관하지 않는다", () => {
  const platformCanary = "1.2.3-canarysecretmustnotpersist";
  const workflowCanary = "9".repeat(40);
  const payload = safeGooglePayload();
  payload.build = {
    minSdk: 23,
    targetSdk: 35,
    platformVersion: platformCanary,
    workflowBundleSha: workflowCanary,
  };
  const result = transformLegacySources(completeVector({ GOOGLE_PLAY_CONFIG: payload }));
  assert.equal(result.status, "DRAFTABLE_WITH_INPUT");
  assert.ok(result.reasons.some((reason) => (
    reason.code === "FREE_TEXT_REQUIRES_INPUT" && reason.path === "$.build.platformVersion"
  )));
  assert.ok(result.reasons.some((reason) => (
    reason.code === "FREE_TEXT_REQUIRES_INPUT" && reason.path === "$.build.workflowBundleSha"
  )));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(platformCanary));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(workflowCanary));
});

test("중복 JSON object key는 마지막 값으로 덮지 않고 fail-closed한다", () => {
  const sources = completeVector({ GOOGLE_PLAY_CONFIG: safeGooglePayload() });
  const google = sources.find((source) => source.sourceKind === "GOOGLE_PLAY_CONFIG");
  assert.ok(google);
  google.text = '{"enabled":true,"enabled":false}';
  const result = transformLegacySources(sources);
  assert.equal(result.status, "NEEDS_INPUT");
  assert.ok(result.reasons.some((reason) => reason.code === "SOURCE_PARSE_ERROR"));

  google.text = '{"enabled":true,"\\u0065nabled":false}';
  const escaped = transformLegacySources(sources);
  assert.equal(escaped.status, "NEEDS_INPUT");
  assert.ok(escaped.reasons.some((reason) => reason.code === "SOURCE_PARSE_ERROR"));
});

test("legal/provider state와 미분류 asset은 부분 DRAFT 밖에 두고 cleanup을 차단한다", () => {
  const payload = {
    ...safeGooglePayload(),
    contentDeclarations: { dataSafety: "draft" },
    releaseStatus: "uploaded",
    assets: { playIcon: "store/icon.png" },
  };
  const result = transformLegacySources(completeVector({ GOOGLE_PLAY_CONFIG: payload }));
  assert.equal(result.status, "DRAFTABLE_WITH_INPUT");
  const codes = new Set(result.reasons.map((reason) => reason.code));
  assert.equal(codes.has("LEGAL_COMPLIANCE_AMBIGUITY"), true);
  assert.equal(codes.has("PROVIDER_STATE_AMBIGUITY"), true);
  assert.equal(codes.has("UNSUPPORTED_FIELD"), true);
});

test("구형 Backoffice 도구 manifest는 desired state 오류가 아니라 사람 검토 대상으로 분리한다", () => {
  const summaryCanary = "legacy-summary-must-not-persist";
  const toolCanary = "legacy-tool-must-not-persist";
  const result = transformLegacySources(completeVector({
    GOOGLE_PLAY_CONFIG: safeGooglePayload(),
    SEORILABS_BACKOFFICE_JSON: {
      $schema: "https://backoffice.example/schema.json",
      version: 1,
      summary: summaryCanary,
      tools: [{ id: toolCanary }],
      analytics: { enabled: true },
    },
  }));

  assert.equal(result.status, "DRAFTABLE_WITH_INPUT");
  assert.ok(result.reasons.some((reason) => (
    reason.code === "UNSUPPORTED_FIELD" && reason.sourceKind === "SEORILABS_BACKOFFICE_JSON"
  )));
  assert.equal(result.reasons.some((reason) => reason.code === "INVALID_DESIRED_STATE"), false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(summaryCanary));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(toolCanary));
});

test("App Store scalar listing과 build 표식은 shape 오류 대신 중앙 검토 대상으로 분리한다", () => {
  const listingCanary = "legacy-listing-must-not-persist";
  const buildCanary = "legacy-build-must-not-persist";
  const result = transformLegacySources(completeVector({
    APP_STORE_CONFIG: {
      primaryLanguage: "ko-KR",
      build: buildCanary,
      storeListing: {
        subtitle: listingCanary,
        description: listingCanary,
        keywords: listingCanary,
      },
    },
  }));

  assert.equal(result.status, "DRAFTABLE_WITH_INPUT");
  assert.equal(result.reasons.some((reason) => reason.code === "INVALID_SOURCE_SHAPE"), false);
  assert.ok(result.reasons.some((reason) => (
    reason.code === "UNSUPPORTED_FIELD" && reason.path === "$.build"
  )));
  assert.ok(result.reasons.some((reason) => reason.code === "FREE_TEXT_REQUIRES_INPUT"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(listingCanary));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(buildCanary));
});

test("scalar build 예외는 App Store에만 허용하고 다른 market은 shape 오류로 차단한다", () => {
  for (const [sourceKind, payload] of [
    ["GOOGLE_PLAY_CONFIG", { defaultLanguage: "ko-KR", build: "unexpected-scalar" }],
    ["APPS_IN_TOSS_CONFIG", { locale: "ko-KR", build: "unexpected-scalar" }],
  ] as const) {
    const result = transformLegacySources(completeVector({ [sourceKind]: payload }));

    assert.equal(result.status, "NEEDS_INPUT");
    assert.ok(result.reasons.some((reason) => (
      reason.code === "INVALID_SOURCE_SHAPE"
      && reason.sourceKind === sourceKind
      && reason.path === "$.build"
    )));
  }
});

test("임의의 잘못된 Backoffice JSON은 도구 manifest로 오인하지 않는다", () => {
  const result = transformLegacySources(completeVector({
    SEORILABS_BACKOFFICE_JSON: {
      version: 1,
      summary: "missing schema and tools",
    },
  }));

  assert.equal(result.status, "NEEDS_INPUT");
  assert.ok(result.reasons.some((reason) => reason.code === "INVALID_DESIRED_STATE"));
});

test("중앙에서 아직 분류하지 못한 legacy asset과 외부 binding은 부분 DRAFT 밖에 둔다", () => {
  const google = {
    ...safeGooglePayload(),
    packageName: "com.example.test",
    assets: { playIcon: { objectKey: "google/icon", checksum: "1".repeat(64) } },
  };
  const appStore = {
    primaryLanguage: "ko-KR",
    bundleId: "com.example.test",
    assets: { appIcon: { objectKey: "apple/icon", checksum: "2".repeat(64) } },
  };
  const result = transformLegacySources(completeVector({
    GOOGLE_PLAY_CONFIG: google,
    APP_STORE_CONFIG: appStore,
  }));
  assert.equal(result.status, "DRAFTABLE_WITH_INPUT");
  const unsupported = result.reasons.filter((reason) => reason.code === "UNSUPPORTED_FIELD");
  assert.ok(unsupported.some((reason) => reason.sourceKind === "GOOGLE_PLAY_CONFIG"));
  assert.ok(unsupported.some((reason) => reason.sourceKind === "APP_STORE_CONFIG"));
});

test("cross-market 자유 텍스트 metadata는 부분 DRAFT에서 제외하고 사람 입력으로 돌린다", () => {
  const google = {
    defaultLanguage: "ko-KR",
    storeListing: { appName: { "ko-KR": "첫 이름" } },
  };
  const appStore = {
    primaryLanguage: "ko-KR",
    storeListing: { appName: { "ko-KR": "둘째 이름" } },
  };
  const result = transformLegacySources(completeVector({
    GOOGLE_PLAY_CONFIG: google,
    APP_STORE_CONFIG: appStore,
  }));
  assert.equal(result.status, "DRAFTABLE_WITH_INPUT");
  assert.ok(result.reasons.some((reason) => reason.code === "FREE_TEXT_REQUIRES_INPUT"));
});

test("누락 source kind와 불일치 cross-repo SHA는 partial vector로 남는다", () => {
  const sources = completeVector({ GOOGLE_PLAY_CONFIG: safeGooglePayload() });
  const withoutPlatform = sources.filter((source) => source.sourceKind !== "PLATFORM_APP_REGISTRY");
  withoutPlatform[1] = { ...withoutPlatform[1], sourceSha: "c".repeat(40) };
  const result = transformLegacySources(withoutPlatform);
  assert.equal(result.status, "NEEDS_INPUT");
  assert.equal(result.coverage.status, "PARTIAL");
  assert.ok(result.reasons.some((reason) => reason.code === "PARTIAL_CROSS_REPO_VECTOR"));
});

test("parity는 semantic array 순서를 정규화하고 완전 coverage에서만 MATCH한다", () => {
  const transformed = transformLegacySources(completeVector({ GOOGLE_PLAY_CONFIG: safeGooglePayload() }));
  assert.equal(transformed.status, "DRAFTABLE");
  if (transformed.status !== "DRAFTABLE") return;
  const central: DraftableConfigRevisionPayload = {
    ...transformed.payload,
    markets: transformed.payload.markets.map((market) => ({ ...market, locales: [...market.locales].reverse() })),
    assets: [...(transformed.payload.assets ?? [])].reverse(),
    localizations: [...(transformed.payload.localizations ?? [])].reverse(),
  };
  const parity = compareLegacyShadow(transformed, central);
  assert.equal(parity.status, "MATCH");
  assert.deepEqual(parity.diffs, []);
  assert.equal(parity.legacyDigest, parity.centralDigest);

  const partial = transformLegacySources(completeVector({ GOOGLE_PLAY_CONFIG: safeGooglePayload() }).slice(0, 6));
  const partialParity = compareLegacyShadow(partial, transformed.payload);
  assert.equal(partialParity.status, "NEEDS_INPUT");
  assert.deepEqual(partialParity.diffs, [{ path: "$", code: "PARTIAL_COVERAGE" }]);
});

test("parity mismatch는 field path와 code만 반환하고 양쪽 값을 포함하지 않는다", () => {
  const transformed = transformLegacySources(completeVector({ GOOGLE_PLAY_CONFIG: safeGooglePayload() }));
  assert.equal(transformed.status, "DRAFTABLE");
  if (transformed.status !== "DRAFTABLE") return;
  const legacyValue = transformed.payload.markets[0]?.locales[0];
  assert.equal(legacyValue, "ko-KR");
  const centralValue = "en-US";
  const central = structuredClone(transformed.payload);
  if (central.markets[0]) central.markets[0].locales = [centralValue];
  const parity = compareLegacyShadow(transformed, central);
  assert.equal(parity.status, "MISMATCH");
  assert.ok(parity.diffs.some((diff) => diff.code === "VALUE_MISMATCH" && diff.path.endsWith(".locales[0]")));
  const serialized = JSON.stringify(parity);
  assert.doesNotMatch(serialized, new RegExp(legacyValue));
  assert.doesNotMatch(serialized, new RegExp(centralValue));
});
