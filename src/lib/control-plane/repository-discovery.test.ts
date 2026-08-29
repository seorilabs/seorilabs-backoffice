import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  discoverRepository,
  readCurrentRepositoryHead,
  readExactRepositoryTree,
  repositoryDiscoverySloState,
  REPOSITORY_DISCOVERY_CONTRACT_VERSION,
  REPOSITORY_DISCOVERY_MAX_LOCKFILE_BYTES,
  REPOSITORY_DISCOVERY_MAX_TREE_PATH_DEPTH,
  REPOSITORY_DISCOVERY_TERMINAL_SLO_MS,
  type RepositoryTreeSnapshot,
} from "@/lib/control-plane/repository-discovery";
import type { SourceObservationResult } from "@/lib/github/source-observation";
import {
  appMarketIdentityConflict,
  reconciledMarketTargets,
} from "@/lib/control-plane/repository-discovery-service";
import { exactBuildTargetIdentity } from "@/lib/control-plane/build-target-identity";

const REPO_ID = 42;
const SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);

function snapshot(
  paths: string[],
  overrides: Partial<RepositoryTreeSnapshot> = {},
): RepositoryTreeSnapshot {
  return {
    repoId: REPO_ID,
    fullName: "seorilabs/sample-app",
    name: "sample-app",
    sourceSha: SHA,
    sourceRef: "refs/heads/main",
    defaultBranch: "main",
    private: true,
    fork: false,
    archived: false,
    paths,
    ...overrides,
  };
}

function sourceReader(files: Record<string, string>) {
  return async (path: string): Promise<SourceObservationResult> => {
    const text = files[path];
    if (text === undefined) {
      return {
        status: "ABSENT",
        reason: "PATH_NOT_FOUND",
        repoId: REPO_ID,
        fullName: "seorilabs/sample-app",
        sourceSha: SHA,
        sourceRef: "refs/heads/main",
        path,
        blobSha: null,
        contentSha256: null,
        size: null,
      };
    }
    return {
      status: "PRESENT",
      reason: null,
      repoId: REPO_ID,
      fullName: "seorilabs/sample-app",
      sourceSha: SHA,
      sourceRef: "refs/heads/main",
      path,
      blobSha: createHash("sha1").update(path).digest("hex"),
      contentSha256: createHash("sha256").update(text).digest("hex"),
      size: Buffer.byteLength(text),
      text,
    };
  };
}

function vendoredChecksum(files: Record<string, string>): string {
  const hash = createHash("sha256");
  hash.update(Buffer.from("seorilabs-vendored-tree-v1\0", "utf8"));
  for (const [path, text] of Object.entries(files).sort(([left], [right]) => (
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  ))) {
    for (const value of [path, text]) {
      const content = Buffer.from(value, "utf8");
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(content.length));
      hash.update(length);
      hash.update(content);
    }
  }
  return hash.digest("hex");
}

test("기존 App adoption은 non-null identity 충돌만 거부하고 desired market target은 비파괴 union한다", () => {
  const discovered = {
    playPackage: "com.seorilabs.sample",
    iosBundle: "com.seorilabs.sample",
    aitAppName: "sample-ait",
    marketTargets: ["ait", "appstore", "play"],
  };
  assert.equal(appMarketIdentityConflict({
    existing: { playPackage: null, iosBundle: null, aitAppName: null, marketTargets: ["web"] },
    discovered,
  }), false);
  assert.equal(appMarketIdentityConflict({
    existing: { ...discovered, marketTargets: ["play", "web", "ait", "appstore"] },
    discovered,
  }), false);
  assert.equal(appMarketIdentityConflict({
    existing: { ...discovered, playPackage: "com.seorilabs.other" },
    discovered,
  }), true);
  assert.equal(appMarketIdentityConflict({
    existing: { ...discovered, marketTargets: ["play", "appstore"] },
    discovered,
  }), false);
  assert.equal(appMarketIdentityConflict({
    existing: { ...discovered, iosBundle: "com.seorilabs.sample" },
    discovered: { ...discovered, iosBundle: null, marketTargets: ["ait", "play"] },
  }), false);
  assert.equal(appMarketIdentityConflict({
    existing: { ...discovered, aitAppName: "other-ait" },
    discovered,
  }), true);

  // alley-market-match/lord-ledger/slotmachine-game처럼 legacy desired target과
  // exact source target 집합이 달라도 registration을 막거나 기존 intent를 지우지 않는다.
  assert.deepEqual(
    reconciledMarketTargets(["play", "appstore"], ["ait", "play"]),
    ["ait", "appstore", "play"],
  );
  assert.deepEqual(
    reconciledMarketTargets(["web", "play"], ["appstore"]),
    ["appstore", "play", "web"],
  );
});

test("release와 resolved manifest는 exact target 공개 identity가 null이면 fail-closed한다", () => {
  const targets = [
    {
      market: "google-play",
      packageId: null,
      bundleId: null,
      configuration: null,
    },
    {
      market: "app-store",
      packageId: null,
      bundleId: "com.seorilabs.sample",
      configuration: null,
    },
    {
      market: "apps-in-toss",
      packageId: null,
      bundleId: null,
      configuration: null,
    },
  ];
  assert.deepEqual(exactBuildTargetIdentity(targets, "google-play"), { status: "IDENTITY_MISSING" });
  assert.equal(exactBuildTargetIdentity(targets, "app-store").status, "READY");
  assert.deepEqual(exactBuildTargetIdentity(targets, "apps-in-toss"), { status: "IDENTITY_MISSING" });
  assert.deepEqual(exactBuildTargetIdentity([], "google-play"), { status: "TARGET_MISSING" });
  assert.deepEqual(
    exactBuildTargetIdentity([targets[1], targets[1]], "app-store"),
    { status: "TARGET_AMBIGUOUS" },
  );
});

test("nullable source identity는 exact market application ExternalBinding으로만 해소한다", () => {
  const googleTarget = {
    market: "google-play",
    packageId: null,
    bundleId: null,
    configuration: null,
  };
  const appStoreTarget = {
    market: "app-store",
    packageId: null,
    bundleId: null,
    configuration: null,
  };
  const appsInTossTarget = {
    market: "apps-in-toss",
    packageId: null,
    bundleId: null,
    configuration: null,
  };
  const googleApplication = {
    provider: "google-play",
    bindingType: "application",
    externalId: "com.seorilabs.sample",
    publicIdentity: "com.seorilabs.sample",
  };
  assert.deepEqual(
    exactBuildTargetIdentity([googleTarget], "google-play", [googleApplication]),
    {
      status: "READY",
      target: googleTarget,
      publicIdentity: "com.seorilabs.sample",
      resolvedBy: "EXTERNAL_BINDING",
    },
  );
  assert.equal(exactBuildTargetIdentity([appStoreTarget], "app-store", [{
    provider: "app-store",
    bindingType: "application",
    externalId: "com.seorilabs.sample",
    publicIdentity: "com.seorilabs.sample",
  }]).status, "READY");
  assert.equal(exactBuildTargetIdentity([appsInTossTarget], "apps-in-toss", [{
    provider: "apps-in-toss",
    bindingType: "mini-app",
    externalId: "sample-app",
    publicIdentity: "sample-app",
  }]).status, "READY");

  // provider 혼동: 다른 market application은 Google Play identity가 아니다.
  assert.deepEqual(exactBuildTargetIdentity([googleTarget], "google-play", [{
    ...googleApplication,
    provider: "app-store",
  }]), { status: "IDENTITY_MISSING" });
  // resourceType 혼동: account/team/workspace와 AIT의 잘못된 application type은 fallback이 아니다.
  assert.deepEqual(exactBuildTargetIdentity([googleTarget], "google-play", [{
    ...googleApplication,
    bindingType: "publisher-account",
  }]), { status: "IDENTITY_MISSING" });
  assert.deepEqual(exactBuildTargetIdentity([appsInTossTarget], "apps-in-toss", [{
    provider: "apps-in-toss",
    bindingType: "application",
    externalId: "sample-app",
    publicIdentity: "sample-app",
  }]), { status: "IDENTITY_MISSING" });
  // resourceId 혼동: application row의 resource ID와 public identity가 다르면 거부한다.
  assert.deepEqual(exactBuildTargetIdentity([googleTarget], "google-play", [{
    ...googleApplication,
    externalId: "publisher-account-1",
  }]), { status: "EXTERNAL_BINDING_INVALID" });
  assert.deepEqual(exactBuildTargetIdentity([googleTarget], "google-play", [
    googleApplication,
    {
      ...googleApplication,
      externalId: "com.seorilabs.other",
      publicIdentity: "com.seorilabs.other",
    },
  ]), { status: "EXTERNAL_BINDING_AMBIGUOUS" });
  assert.deepEqual(
    exactBuildTargetIdentity([googleTarget], "app-store", [googleApplication]),
    { status: "TARGET_MISSING" },
  );
  assert.deepEqual(exactBuildTargetIdentity([{
    ...googleTarget,
    packageId: "com.seorilabs.source",
  }], "google-play", [{
    ...googleApplication,
    externalId: "com.seorilabs.provider",
    publicIdentity: "com.seorilabs.provider",
  }]), { status: "IDENTITY_CONFLICT" });
});

test("RN monorepo의 exact package manager, workingDirectory와 세 market target을 탐지한다", async () => {
  const canary = "discovery-secret-canary-must-not-persist";
  const files = {
    "package.json": JSON.stringify({
      name: "sample-root",
      packageManager: "pnpm@11.3.0",
      scripts: { test: "pnpm --dir apps/mobile test" },
      unsafeCustomField: canary,
    }),
    "apps/mobile/package.json": JSON.stringify({
      name: "sample-mobile",
      dependencies: { "react-native": "0.81.0" },
    }),
    "apps/ait/package.json": JSON.stringify({
      name: "sample-ait",
      dependencies: {
        "react-native": "0.81.0",
        "@apps-in-toss/framework": "2.10.7",
      },
    }),
    "apps/mobile/android/app/build.gradle": 'android { defaultConfig { applicationId "com.seorilabs.sample" } }',
    "apps/mobile/ios/Sample.xcodeproj/project.pbxproj": "PRODUCT_BUNDLE_IDENTIFIER = com.seorilabs.sample;",
    "apps/ait/granite.config.ts": "export default { appName: 'sample-ait' };",
    "build.env": "AAB_PATH=release-artifacts/android/app-release.aab\n",
    "scripts/build-android.sh": "#!/bin/sh\nexit 0\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  };
  const paths = Object.keys(files);
  const result = await discoverRepository(snapshot(paths), sourceReader(files));

  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.equal(result.classification, "PRODUCT_APP");
  assert.deepEqual(result.workflowCaller, {
    profile: "react-native",
    packageManager: "pnpm",
    workingDirectory: "apps/mobile",
  });
  assert.deepEqual(result.buildBindings, [{
    target: "android",
    buildProfile: "react-native-android",
    packageManager: "pnpm",
    executionRoot: ".",
    dependencyRoot: ".",
    scriptPath: "scripts/build-android.sh",
    artifactKind: "android-aab",
  }]);
  assert.deepEqual(result.buildTargets, [
    {
      targetKey: "ait",
      stack: "react-native",
      market: "apps-in-toss",
      packageId: null,
      bundleId: null,
      configuration: { appName: "sample-ait" },
    },
    {
      targetKey: "android",
      stack: "react-native",
      market: "google-play",
      packageId: "com.seorilabs.sample",
      bundleId: null,
      configuration: null,
    },
    {
      targetKey: "ios",
      stack: "react-native",
      market: "app-store",
      packageId: null,
      bundleId: "com.seorilabs.sample",
      configuration: null,
    },
  ]);
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(result.sourceMetadata.every((source) => !("text" in source)), true);
});

test("RN root Android binding의 pnpm lockfile만 전용 대용량 한도로 읽는다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "sample-mobile",
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0" },
    }),
    "android/app/build.gradle": 'android { defaultConfig { applicationId "com.seorilabs.sample" } }',
    "build.env": "AAB_PATH=release-artifacts/android/app-release.aab\n",
    "scripts/build-android.sh": "#!/bin/sh\nexit 0\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  };
  const readLimits = new Map<string, number | undefined>();
  const read = sourceReader(files);
  const result = await discoverRepository(
    snapshot(Object.keys(files)),
    async (path, maxBytes) => {
      readLimits.set(path, maxBytes);
      return read(path);
    },
  );

  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.equal(readLimits.get("pnpm-lock.yaml"), REPOSITORY_DISCOVERY_MAX_LOCKFILE_BYTES);
  assert.equal(readLimits.get("build.env"), undefined);
  assert.equal(readLimits.get("scripts/build-android.sh"), undefined);
  assert.deepEqual(result.buildBindings, [{
    target: "android",
    buildProfile: "react-native-android",
    packageManager: "pnpm",
    executionRoot: ".",
    dependencyRoot: ".",
    scriptPath: "scripts/build-android.sh",
    artifactKind: "android-aab",
  }]);
});

test("Capacitor product는 web AIT dependency가 함께 있어도 primary static profile로 탐지한다", async () => {
  const files = {
    "package.json": JSON.stringify({ name: "root", packageManager: "pnpm@11.3.0" }),
    "app/package.json": JSON.stringify({
      name: "capacitor-product",
      dependencies: {
        "@capacitor/core": "8.5.0",
        "@apps-in-toss/web-framework": "2.10.7",
        "@seorilabs/platform-sdk": "0.6.7",
      },
    }),
    "app/android/app/build.gradle": 'android { defaultConfig { applicationId "com.seorilabs.capacitor" } }',
    "app/ios/App.xcodeproj/project.pbxproj": "PRODUCT_BUNDLE_IDENTIFIER = com.seorilabs.capacitor;",
    "app/granite.config.ts": "export default { appName: 'capacitor-product' };",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\n",
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.workflowCaller, {
    profile: "capacitor",
    packageManager: "pnpm",
    workingDirectory: "app",
  });
  assert.deepEqual(result.candidates, [{
    profile: "capacitor",
    workingDirectory: "app",
    markerPath: "app/package.json",
  }]);
  assert.deepEqual(result.buildTargets.map(({ targetKey, stack }) => ({ targetKey, stack })), [
    { targetKey: "ait", stack: "capacitor" },
    { targetKey: "android", stack: "capacitor" },
    { targetKey: "ios", stack: "capacitor" },
  ]);
});

test("workspace RN application marker가 유일하면 peer dependency UI library를 후보에서 제외한다", async () => {
  const files = {
    "package.json": JSON.stringify({ name: "workspace", packageManager: "pnpm@11.3.0" }),
    "apps/mobile/package.json": JSON.stringify({
      name: "@sample/mobile",
      dependencies: { "react-native": "0.86.0" },
    }),
    "apps/mobile/app.json": JSON.stringify({ name: "sample" }),
    "apps/mobile/android/app/build.gradle": 'android { defaultConfig { applicationId "com.seorilabs.sample" } }',
    "packages/product-ui/package.json": JSON.stringify({
      name: "@sample/product-ui",
      peerDependencies: { "react-native": ">=0.84.0" },
      devDependencies: { "react-native": "0.86.0" },
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\n",
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.candidates, [{
    profile: "react-native",
    workingDirectory: "apps/mobile",
    markerPath: "apps/mobile/package.json",
  }]);
  assert.equal(result.workflowCaller.workingDirectory, "apps/mobile");
});

test("AppsInToss web-only product는 RN으로 추측하지 않고 ait-web profile로 탐지한다", async () => {
  const files = {
    "apps-in-toss/package.json": JSON.stringify({
      name: "ait-web-product",
      packageManager: "npm@11.0.0",
      dependencies: { "@apps-in-toss/web-framework": "2.10.7" },
    }),
    "apps-in-toss/granite.config.ts": "export default { appName: 'ait-web-product' };",
    "apps-in-toss/package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.workflowCaller, {
    profile: "ait-web",
    packageManager: "npm",
    workingDirectory: "apps-in-toss",
  });
  assert.deepEqual(result.buildTargets, [{
    targetKey: "ait",
    stack: "ait-web",
    market: "apps-in-toss",
    packageId: null,
    bundleId: null,
    configuration: { appName: "ait-web-product" },
  }]);
});

test("AIT application marker가 유일하면 workspace의 web framework library를 후보에서 제외한다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "ait-product",
      packageManager: "npm@11.0.0",
      dependencies: { "@apps-in-toss/web-framework": "2.10.7" },
    }),
    "granite.config.ts": "export default { appName: 'ait-product' };",
    "packages/ait-core/package.json": JSON.stringify({
      name: "@sample/ait-core",
      dependencies: { "@apps-in-toss/web-framework": "2.10.7" },
    }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.candidates, [{
    profile: "ait-web",
    workingDirectory: ".",
    markerPath: "package.json",
  }]);
  assert.deepEqual(result.buildTargets.map((target) => target.targetKey), ["ait"]);
});

test("Godot 제품의 AIT web delivery package는 별도 제품 후보가 아니라 nullable companion target이다", async () => {
  const files = {
    "godot/project.godot": "[application]\nconfig/name=\"Sample\"\n",
    "godot/export_presets.cfg": [
      "[preset.0]",
      'name="Android"',
      'platform="Android"',
      "[preset.0.options]",
      'package/unique_name="com.seorilabs.sample"',
    ].join("\n"),
    "ait/apps-in-toss-web/package.json": JSON.stringify({
      name: "sample-ait-web",
      dependencies: { "@apps-in-toss/web-framework": "3.0.5" },
    }),
    "ait/apps-in-toss-web/apps-in-toss.config.ts": "export default { appName: 'sample-ait' };",
    "ait/apps-in-toss-web/package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.candidates, [{
    profile: "godot",
    workingDirectory: "godot",
    markerPath: "godot/project.godot",
  }]);
  assert.deepEqual(result.buildTargets.map(({ targetKey, market, configuration }) => ({
    targetKey,
    market,
    configuration,
  })), [
    { targetKey: "ait", market: "apps-in-toss", configuration: { appName: "sample-ait" } },
    { targetKey: "android", market: "google-play", configuration: null },
  ]);
});

test("RN exact package와 lock integrity를 PLATFORM_SDK_UPDATE용 source observation으로 만든다", async () => {
  const files = {
    "package.json": JSON.stringify({ name: "sample", packageManager: "pnpm@11.3.0" }),
    "apps/mobile/package.json": JSON.stringify({
      name: "sample-mobile",
      dependencies: {
        "react-native": "0.81.0",
        "@seorilabs/platform-sdk": "0.4.0",
      },
    }),
    "apps/mobile/android/app/build.gradle": 'android { defaultConfig { applicationId "com.seorilabs.sample" } }',
    "pnpm-lock.yaml": [
      "lockfileVersion: '9.0'",
      "importers:",
      "  apps/mobile:",
      "    dependencies:",
      "      '@seorilabs/platform-sdk':",
      "        specifier: 0.4.0",
      "        version: 0.4.0",
      "packages:",
      "  '@seorilabs/platform-sdk@0.4.0':",
      "    resolution:",
      `      integrity: sha512-${createHash("sha512").update("platform-sdk").digest("base64")}`,
    ].join("\n"),
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.platformConsumer, {
    schemaVersion: 1,
    sourceSha: SHA,
    integration: "SDK",
    artifactKind: "TYPESCRIPT",
    observedVersion: "0.4.0",
    observedDigest: null,
    contractRevision: null,
    evidenceDigest: result.platformConsumer.evidenceDigest,
    lockIntegrity: `sha512-${createHash("sha512").update("platform-sdk").digest("base64")}`,
  });
  assert.match(result.platformConsumer.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal((result.payload.platformConsumer as { integration: string }).integration, "SDK");
});

test("AIT-only Granite RN package를 primary candidate와 exact target으로 탐지한다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "trait-test-hub",
      packageManager: "pnpm@11.3.0",
    }),
    "apps/ait/package.json": JSON.stringify({
      name: "@seorilabs/trait-test-ait",
      dependencies: {
        "react-native": "0.84.0",
        "@apps-in-toss/framework": "2.10.7",
        "@granite-js/react-native": "1.0.28",
      },
    }),
    "apps/ait/granite.config.ts": "export default { appName: 'trait-test-hub' };",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\n",
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.workflowCaller, {
    profile: "react-native",
    packageManager: "pnpm",
    workingDirectory: "apps/ait",
  });
  assert.deepEqual(result.candidates, [{
    profile: "react-native",
    workingDirectory: "apps/ait",
    markerPath: "apps/ait/package.json",
  }]);
  assert.deepEqual(result.buildTargets, [{
    targetKey: "ait",
    stack: "react-native",
    market: "apps-in-toss",
    packageId: null,
    bundleId: null,
    configuration: { appName: "trait-test-hub" },
  }]);
});

test("multi-market repo는 native RN 후보가 있으면 AIT delivery package를 중복 후보로 계산하지 않는다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "sample-root",
      packageManager: "pnpm@11.3.0",
    }),
    "apps/mobile/package.json": JSON.stringify({
      name: "sample-mobile",
      dependencies: { "react-native": "0.85.0" },
    }),
    "apps/ait/package.json": JSON.stringify({
      name: "sample-ait",
      dependencies: {
        "react-native": "0.84.0",
        "@apps-in-toss/framework": "2.10.7",
        "@granite-js/react-native": "1.0.28",
      },
    }),
    "apps/mobile/android/app/build.gradle": 'android { defaultConfig { applicationId "com.seorilabs.sample" } }',
    "apps/ait/granite.config.ts": "export default { appName: 'sample-ait' };",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\n",
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.equal(result.workflowCaller.workingDirectory, "apps/mobile");
  assert.deepEqual(result.candidates, [{
    profile: "react-native",
    workingDirectory: "apps/mobile",
    markerPath: "apps/mobile/package.json",
  }]);
});

test("RN floating Platform dependency는 관리 SDK로 추측하지 않는다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "sample",
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0", "@seorilabs/platform-sdk": "^0.4.0" },
    }),
    "android/app/build.gradle": 'android { defaultConfig { applicationId "com.seorilabs.sample" } }',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  };
  const read = sourceReader(files);
  const result = await discoverRepository(snapshot(Object.keys(files)), async (path) => {
    assert.notEqual(path, "pnpm-lock.yaml", "floating dependency의 lockfile은 읽지 않아야 한다");
    return read(path);
  });
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.equal(result.platformConsumer.integration, "CUSTOM_HTTP");
});

test("Godot production preset은 package manager 없이 debug identity를 제외한 caller와 target을 만든다", async () => {
  const files = {
    "project.godot": "[application]\nconfig/name=\"Sample\"\n",
    "export_presets.cfg": [
      "[preset.0]",
      'name="Android"',
      'platform="Android"',
      "[preset.0.options]",
      'package/unique_name="com.seorilabs.game"',
      "[preset.1]",
      'name="Android Debug"',
      'platform="Android"',
      "[preset.1.options]",
      'package/unique_name="com.seorilabs.game.debug"',
      "[preset.2]",
      'name="iOS"',
      'platform="iOS"',
      "[preset.2.options]",
      'application/bundle_identifier="com.seorilabs.game"',
    ].join("\n"),
    "apps/ait/granite.config.ts": "export default { appName: `sample-game` };",
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));

  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.equal(result.classification, "PRODUCT_APP");
  assert.deepEqual(result.workflowCaller, {
    profile: "godot",
    packageManager: null,
    workingDirectory: ".",
  });
  assert.deepEqual(
    result.buildTargets.map((target) => [target.targetKey, target.packageId ?? target.bundleId ?? null]),
    [["ait", null], ["android", "com.seorilabs.game"], ["ios", "com.seorilabs.game"]],
  );
});

test("lizard 유형은 build.env의 Android target과 미관측 package identity를 분리한다", async () => {
  const files = {
    "project.godot": "[application]\nconfig/name=\"Lizard\"\n",
    "build.env": "AAB_PATH=release-artifacts/android/app-release.aab\n",
    "scripts/build-android.sh": "#!/bin/sh\nexit 0\n",
    "apps/ait/granite.config.ts": "export default { appName: 'lizard-tycoon' };",
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.buildBindings, [{
    target: "android",
    buildProfile: "godot-android",
    packageManager: null,
    executionRoot: ".",
    dependencyRoot: ".",
    scriptPath: "scripts/build-android.sh",
    artifactKind: "android-aab",
  }]);
  assert.deepEqual(result.buildTargets, [
    {
      targetKey: "ait",
      stack: "godot",
      market: "apps-in-toss",
      packageId: null,
      bundleId: null,
      configuration: { appName: "lizard-tycoon" },
    },
    {
      targetKey: "android",
      stack: "godot",
      market: "google-play",
      packageId: null,
      bundleId: null,
      configuration: null,
    },
  ]);
});

test("minimax 유형은 확정 전 Godot package와 bundle identity를 null observation으로 보존한다", async () => {
  const files = {
    "godot/project.godot": "[application]\nconfig/name=\"MiniMax\"\n",
    "godot/export_presets.cfg": [
      "[preset.0]", 'name="Android"', 'platform="Android"',
      "[preset.0.options]", 'package/unique_name="확정 필요"',
      "[preset.1]", 'name="iOS"', 'platform="iOS"',
      "[preset.1.options]", 'application/bundle_identifier="확정 필요"',
    ].join("\n"),
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.buildTargets, [
    {
      targetKey: "android",
      stack: "godot",
      market: "google-play",
      packageId: null,
      bundleId: null,
      configuration: null,
    },
    {
      targetKey: "ios",
      stack: "godot",
      market: "app-store",
      packageId: null,
      bundleId: null,
      configuration: null,
    },
  ]);
});

test("spiritgate 유형은 동적 AIT appName을 null로 두고 관측된 Android identity는 유지한다", async () => {
  const files = {
    "project.godot": "[application]\nconfig/name=\"Spiritgate\"\n",
    "export_presets.cfg": [
      "[preset.0]", 'name="Android"', 'platform="Android"',
      "[preset.0.options]", 'package/unique_name="com.seorilabs.spiritgatedefenders"',
    ].join("\n"),
    "apps/ait/granite.config.ts": [
      "const appName = process.env.AIT_APP_NAME?.trim();",
      "export default { appName };",
    ].join("\n"),
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.buildTargets, [
    {
      targetKey: "ait",
      stack: "godot",
      market: "apps-in-toss",
      packageId: null,
      bundleId: null,
      configuration: null,
    },
    {
      targetKey: "android",
      stack: "godot",
      market: "google-play",
      packageId: "com.seorilabs.spiritgatedefenders",
      bundleId: null,
      configuration: null,
    },
  ]);
});

test("Godot fixed release URL과 vendored tree checksum을 exact SDK observation으로 만든다", async () => {
  const version = "1.2.3";
  const addonFiles = {
    SOURCE: `https://github.com/seorilabs/platform/releases/download/v${version}/seorilabs-platform-gdscript-${version}.tar.gz\n`,
    VERSION: `${version}\n`,
    "platform_client.gd": `const SDK_VERSION := "${version}"\n`,
  };
  const checksum = vendoredChecksum(addonFiles);
  const files = {
    "package.json": JSON.stringify({ name: "sample", packageManager: "npm@11.0.0" }),
    "project.godot": "[application]\n",
    "export_presets.cfg": [
      "[preset.0]",
      'name="Android"',
      'platform="Android"',
      "[preset.0.options]",
      'package/unique_name="com.seorilabs.game"',
    ].join("\n"),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
    ...Object.fromEntries(Object.entries(addonFiles).map(([path, text]) => [
      `addons/seorilabs_platform/${path}`,
      text,
    ])),
    "addons/seorilabs_platform/CHECKSUM": `${checksum}\n`,
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.platformConsumer, {
    schemaVersion: 1,
    sourceSha: SHA,
    integration: "SDK",
    artifactKind: "GDSCRIPT",
    observedVersion: version,
    observedDigest: null,
    contractRevision: null,
    evidenceDigest: result.platformConsumer.evidenceDigest,
    releaseAssetUrl: addonFiles.SOURCE.trim(),
    treeChecksum: checksum,
  });
});

test("Godot addon subtree에 gitlink가 있으면 관리 SDK로 승인하지 않는다", async () => {
  const version = "1.2.3";
  const files = {
    "package.json": JSON.stringify({ name: "sample", packageManager: "npm@11.0.0" }),
    "project.godot": "[application]\n",
    "export_presets.cfg": [
      "[preset.0]", 'name="Android"', 'platform="Android"',
      "[preset.0.options]", 'package/unique_name="com.seorilabs.game"',
    ].join("\n"),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
    "addons/seorilabs_platform/SOURCE": `https://github.com/seorilabs/platform/releases/download/v${version}/seorilabs-platform-gdscript-${version}.tar.gz\n`,
    "addons/seorilabs_platform/VERSION": `${version}\n`,
    "addons/seorilabs_platform/CHECKSUM": `${"a".repeat(64)}\n`,
  };
  const result = await discoverRepository(
    snapshot(Object.keys(files), { gitlinkPaths: ["addons/seorilabs_platform/vendor"] }),
    sourceReader(files),
  );
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.equal(result.platformConsumer.integration, "CUSTOM_HTTP");
});

test("Godot floating main SOURCE는 CUSTOM_HTTP unmanaged로 탐지한다", async () => {
  const files = {
    "package.json": JSON.stringify({ name: "sample", packageManager: "npm@11.0.0" }),
    "project.godot": "[application]\n",
    "export_presets.cfg": [
      "[preset.0]",
      'name="Android"',
      'platform="Android"',
      "[preset.0.options]",
      'package/unique_name="com.seorilabs.game"',
    ].join("\n"),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
    "game/addons/seorilabs_platform/SOURCE": "https://github.com/seorilabs/platform/tree/main/sdk-gdscript\n",
    "game/addons/seorilabs_platform/VERSION": "1.2.3\n",
    "game/addons/seorilabs_platform/CHECKSUM": `${"a".repeat(64)}\n`,
    "game/addons/seorilabs_platform/platform_client.gd": "extends RefCounted\n",
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.equal(result.platformConsumer.integration, "CUSTOM_HTTP");
});

test("RN과 Godot 후보가 함께 있으면 추측하지 않고 MULTIPLE_CANDIDATES다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "mixed",
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0" },
    }),
    "project.godot": "[application]\n",
  };
  const result = await discoverRepository(
    snapshot([...Object.keys(files), "pnpm-lock.yaml"]),
    sourceReader(files),
  );
  assert.equal(result.status, "NEEDS_INPUT");
  assert.equal(result.reasonCode, "MULTIPLE_CANDIDATES");
  assert.equal(result.candidates.length, 2);
});

test("분류 revision이 선택한 exact marker만 PRODUCT_APP 후보로 사용한다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "mixed",
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0" },
    }),
    "android/app/build.gradle": 'android { defaultConfig { applicationId "com.seorilabs.mixed" } }',
    "project.godot": "[application]\n",
  };
  const result = await discoverRepository(
    snapshot([...Object.keys(files), "pnpm-lock.yaml"]),
    sourceReader(files),
    { revision: 1, classification: "PRODUCT_APP", candidateMarkerPath: "package.json" },
  );
  assert.equal(result.status, "ACTIVE");
  if (result.status === "ACTIVE") {
    assert.equal(result.workflowCaller.profile, "react-native");
    assert.equal(result.classification, "PRODUCT_APP");
  }
});

test("platform SDK producer는 앱 profile로 위장하지 않고 명시적으로 제외한다", async () => {
  const files = {
    "package.json": JSON.stringify({ name: "seorilabs-platform", packageManager: "pnpm@11.3.0" }),
    "sdk-gdscript/project.godot": "[application]\n",
  };
  const result = await discoverRepository(snapshot(
    [...Object.keys(files), "spec/openapi.yaml", "pnpm-lock.yaml"],
    { fullName: "seorilabs/platform", name: "platform" },
  ), sourceReader(files));
  assert.equal(result.status, "EXCLUDED");
  assert.equal(result.managementKind, "PLATFORM_PRODUCER");
  assert.equal(result.classification, "PLATFORM_PRODUCER");
  assert.equal(result.reasonCode, "PLATFORM_SDK_PRODUCER");
  assert.equal(result.candidates.length, 0);
});

test("중앙 정책은 인프라와 템플릿을 앱 후보보다 먼저 terminal 분류한다", async () => {
  const infra = await discoverRepository(snapshot(
    ["package.json", "pnpm-lock.yaml"],
    { fullName: "seorilabs/seorilabs-backoffice", name: "seorilabs-backoffice" },
  ), sourceReader({
    "package.json": JSON.stringify({
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0" },
    }),
  }));
  assert.equal(infra.status, "EXCLUDED");
  if (infra.status === "EXCLUDED") {
    assert.equal(infra.classification, "INFRA_REPO");
    assert.equal(infra.reasonCode, "INFRASTRUCTURE_REPOSITORY");
  }

  const template = await discoverRepository(snapshot(
    ["package.json", "pnpm-lock.yaml"],
    { fullName: "seorilabs/starter-template-app", name: "starter-template-app" },
  ), sourceReader({
    "package.json": JSON.stringify({
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0" },
    }),
  }));
  assert.equal(template.status, "EXCLUDED");
  if (template.status === "EXCLUDED") {
    assert.equal(template.classification, "EXCLUDED");
    assert.equal(template.reasonCode, "NON_PRODUCT_REPOSITORY");
  }
});

test("tree에 있던 source가 exact SHA에서 읽히지 않으면 SOURCE_FILE_UNREADABLE이다", async () => {
  const result = await discoverRepository(
    snapshot(["package.json"]),
    sourceReader({}),
  );
  assert.equal(result.status, "NEEDS_INPUT");
  assert.equal(result.reasonCode, "SOURCE_FILE_UNREADABLE");
  assert.equal(result.sourceMetadata[0]?.status, "ABSENT");
});

test("앱 후보에 마켓 build target이 없으면 추측 등록하지 않는다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "incomplete-app",
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0" },
    }),
  };
  const result = await discoverRepository(
    snapshot([...Object.keys(files), "pnpm-lock.yaml"]),
    sourceReader(files),
  );
  assert.equal(result.status, "NEEDS_INPUT");
  assert.equal(result.reasonCode, "BUILD_TARGET_MISSING");
});

test("RN target은 동적 build identity를 null exact-source observation으로 보존한다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "incomplete-app",
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0" },
    }),
    "android/app/build.gradle": "android { defaultConfig { applicationId providers.gradleProperty('appId') } }",
  };
  const result = await discoverRepository(
    snapshot([...Object.keys(files), "pnpm-lock.yaml"]),
    sourceReader(files),
  );
  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.buildTargets, [{
    targetKey: "android",
    stack: "react-native",
    market: "google-play",
    packageId: null,
    bundleId: null,
    configuration: null,
  }]);
});

test("같은 source target에서 서로 다른 공개 build identity가 둘 이상이면 계속 fail-closed한다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "ambiguous-app",
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0" },
    }),
    "android/app/build.gradle": [
      'android { defaultConfig { applicationId "com.seorilabs.first" } }',
      'android { productFlavors { second { applicationId "com.seorilabs.second" } } }',
    ].join("\n"),
  };
  const result = await discoverRepository(
    snapshot([...Object.keys(files), "pnpm-lock.yaml"]),
    sourceReader(files),
  );
  assert.equal(result.status, "NEEDS_INPUT");
  assert.equal(result.reasonCode, "BUILD_IDENTITY_AMBIGUOUS");
});

test("GitHub numeric identity, exact default HEAD와 non-truncated tree를 검증한다", async (t) => {
  const calls: Array<Record<string, unknown>> = [];
  const fake = (overrides: {
    repo?: Record<string, unknown>;
    commit?: Record<string, unknown>;
    tree?: Record<string, unknown>;
  } = {}) => ({
    rest: {
      repos: {
        async get(args: Record<string, unknown>) {
          calls.push({ kind: "repo", ...args });
          return { data: overrides.repo ?? {
            id: REPO_ID,
            full_name: "seorilabs/sample-app",
            name: "sample-app",
            default_branch: "main",
            private: true,
            fork: false,
            archived: false,
          } };
        },
        async getCommit(args: Record<string, unknown>) {
          calls.push({ kind: "commit", ...args });
          return { data: overrides.commit ?? { sha: SHA, commit: { tree: { sha: TREE_SHA } } } };
        },
      },
      git: {
        async getTree(args: Record<string, unknown>) {
          calls.push({ kind: "tree", ...args });
          return { data: overrides.tree ?? {
            sha: TREE_SHA,
            truncated: false,
            tree: [
              { path: "package.json", type: "blob" },
              { path: "addons/seorilabs_platform/vendor", type: "commit" },
            ],
          } };
        },
      },
    },
  });

  await t.test("ready", async () => {
    const result = await readExactRepositoryTree(fake() as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/sample-app",
      expectedSourceSha: SHA.toUpperCase(),
    });
    assert.equal(result.status, "READY");
    if (result.status === "READY") {
      assert.deepEqual(result.snapshot.paths, ["package.json"]);
      assert.deepEqual(result.snapshot.gitlinkPaths, ["addons/seorilabs_platform/vendor"]);
    }
    assert.equal(calls.some((call) => call.kind === "commit" && call.ref === "main"), true);
    assert.equal(calls.some((call) => call.kind === "tree" && call.tree_sha === TREE_SHA), true);
  });

  await t.test("foam-party의 14-depth vendored Firebase xcframework path", async () => {
    const firebasePath = "godot/ios/plugins/firebase_core/FirebaseCore.xcframework/macos-arm64_x86_64/FirebaseCore.framework/Versions/A/Resources/FirebaseCore_Privacy.bundle/Contents/Resources/PrivacyInfo.xcprivacy";
    assert.equal(firebasePath.split("/").length, 14);
    const result = await readExactRepositoryTree(fake({
      tree: {
        sha: TREE_SHA,
        truncated: false,
        tree: [{ path: firebasePath, type: "blob" }],
      },
    }) as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/sample-app",
      expectedSourceSha: SHA,
    });
    assert.equal(result.status, "READY");
    if (result.status === "READY") assert.deepEqual(result.snapshot.paths, [firebasePath]);
  });

  await t.test("tree path traversal과 명시적 depth 상한은 계속 거부", async () => {
    const tooDeep = Array.from(
      { length: REPOSITORY_DISCOVERY_MAX_TREE_PATH_DEPTH + 1 },
      (_, index) => `d${index}`,
    ).join("/");
    const invalidPaths = [
      "/absolute/path",
      "backslash\\path",
      "nul\0path",
      "dot/./path",
      "parent/../path",
      "empty//segment",
      tooDeep,
    ];
    for (const path of invalidPaths) {
      const result = await readExactRepositoryTree(fake({
        tree: {
          sha: TREE_SHA,
          truncated: false,
          tree: [{ path, type: "blob" }],
        },
      }) as never, {
        repoId: REPO_ID,
        fullName: "seorilabs/sample-app",
        expectedSourceSha: SHA,
      });
      assert.equal(result.status, "NEEDS_INPUT", path);
      assert.equal(result.reasonCode, "TREE_INVALID", path);
    }
  });

  await t.test("numeric ID mismatch", async () => {
    const result = await readExactRepositoryTree(fake({ repo: {
      id: REPO_ID + 1,
      full_name: "seorilabs/sample-app",
      name: "sample-app",
      default_branch: "main",
      private: true,
      fork: false,
      archived: false,
    } }) as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/sample-app",
      expectedSourceSha: SHA,
    });
    assert.equal(result.status, "NEEDS_INPUT");
    assert.equal(result.reasonCode, "REPOSITORY_ID_MISMATCH");
  });

  await t.test("source drift", async () => {
    const newer = "c".repeat(40);
    const result = await readExactRepositoryTree(fake({
      commit: { sha: newer, commit: { tree: { sha: TREE_SHA } } },
    }) as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/sample-app",
      expectedSourceSha: SHA,
    });
    assert.deepEqual(result, {
      status: "STALE",
      reasonCode: "SOURCE_DRIFT",
      actualHeadSha: newer,
      private: true,
      fork: false,
    });
  });

  await t.test("truncated tree", async () => {
    const result = await readExactRepositoryTree(fake({
      tree: { sha: TREE_SHA, truncated: true, tree: [] },
    }) as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/sample-app",
      expectedSourceSha: SHA,
    });
    assert.equal(result.status, "NEEDS_INPUT");
    assert.equal(result.reasonCode, "TREE_TRUNCATED");
  });

  await t.test("fork는 자동 PRODUCT_APP 탐지를 시작하지 않는다", async () => {
    const before = calls.length;
    const result = await readExactRepositoryTree(fake({ repo: {
      id: REPO_ID,
      full_name: "seorilabs/forked-app",
      name: "forked-app",
      default_branch: "main",
      private: true,
      fork: true,
      archived: false,
    } }) as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/forked-app",
    });
    assert.deepEqual(result, { status: "NEEDS_INPUT", reasonCode: "FORK_REPOSITORY" });
    assert.equal(calls.slice(before).some((call) => call.kind === "commit"), false);
  });

  await t.test("사람이 확인한 fork EXCLUDED 결정은 exact identity readback 뒤 terminal 처리한다", async () => {
    const result = await readExactRepositoryTree(fake({ repo: {
      id: REPO_ID,
      full_name: "seorilabs/forked-app",
      name: "forked-app",
      default_branch: "main",
      private: true,
      fork: true,
      archived: false,
    } }) as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/forked-app",
      classificationDecision: {
        revision: 1,
        classification: "EXCLUDED",
        candidateMarkerPath: null,
      },
    });
    assert.deepEqual(result, {
      status: "CLASSIFIED",
      classification: "EXCLUDED",
      reasonCode: "NON_PRODUCT_REPOSITORY",
    });
  });

  await t.test("중앙 정책의 공개 제품은 source read만 허용하고 미등록 public은 거부", async () => {
    const approved = await readExactRepositoryTree(fake({ repo: {
      id: REPO_ID,
      full_name: "seorilabs/periodic-table-app",
      name: "periodic-table-app",
      default_branch: "main",
      private: false,
      fork: false,
      archived: false,
    } }) as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/periodic-table-app",
      expectedSourceSha: SHA,
    });
    assert.equal(approved.status, "READY");
    if (approved.status === "READY") assert.equal(approved.snapshot.private, false);

    const unapproved = await readExactRepositoryTree(fake({ repo: {
      id: REPO_ID,
      full_name: "seorilabs/unapproved-public-app",
      name: "unapproved-public-app",
      default_branch: "main",
      private: false,
      fork: false,
      archived: false,
    } }) as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/unapproved-public-app",
      expectedSourceSha: SHA,
    });
    assert.deepEqual(unapproved, {
      status: "NEEDS_INPUT",
      reasonCode: "PUBLIC_REPOSITORY_REQUIRES_POLICY",
    });
  });

  await t.test("중앙 exact INFRA 정책은 public source gate 전에 terminal 분류한다", async () => {
    const before = calls.length;
    const octokit = fake({ repo: {
      id: REPO_ID,
      full_name: "seorilabs/seorilabs-backoffice",
      name: "seorilabs-backoffice",
      default_branch: "main",
      private: false,
      fork: false,
      archived: false,
    } });
    const classified = await readExactRepositoryTree(octokit as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/seorilabs-backoffice",
      expectedSourceSha: SHA,
    });
    assert.deepEqual(classified, {
      status: "CLASSIFIED",
      classification: "INFRA_REPO",
      reasonCode: "INFRASTRUCTURE_REPOSITORY",
    });
    assert.equal(calls.slice(before).some((call) => call.kind === "commit" || call.kind === "tree"), false);

    const head = await readCurrentRepositoryHead(octokit as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/seorilabs-backoffice",
    });
    assert.deepEqual(head, { status: "READY", sourceSha: SHA, sourceRef: "refs/heads/main" });
  });
});

test("discovery 의미론 변경은 새 generation을 강제하는 v8 계약이다", () => {
  assert.equal(REPOSITORY_DISCOVERY_CONTRACT_VERSION, "repository-discovery/v8");
});

test("10분 안에 끝나지 않은 non-terminal run만 OVERDUE로 분류한다", () => {
  const createdAt = new Date("2026-08-28T00:00:00.000Z");
  assert.equal(repositoryDiscoverySloState({
    createdAt,
    now: new Date(createdAt.getTime() + REPOSITORY_DISCOVERY_TERMINAL_SLO_MS - 1),
    status: "QUEUED",
  }), "WITHIN_SLO");
  assert.equal(repositoryDiscoverySloState({
    createdAt,
    now: new Date(createdAt.getTime() + REPOSITORY_DISCOVERY_TERMINAL_SLO_MS),
    status: "RUNNING",
  }), "OVERDUE");
  assert.equal(repositoryDiscoverySloState({
    createdAt,
    now: new Date(createdAt.getTime() + REPOSITORY_DISCOVERY_TERMINAL_SLO_MS * 2),
    status: "NEEDS_INPUT",
  }), "TERMINAL");
});
