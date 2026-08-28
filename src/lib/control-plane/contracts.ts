import { z } from "zod";
import {
  AUTOMATION_APPROVAL_POLICIES,
  AUTOMATION_AGENT_KINDS,
  AUTOMATION_CADENCES,
  AUTOMATION_TEMPLATE_KEY,
} from "@/lib/control-plane/automation-catalog";

const sha40 = z.string().regex(/^[0-9a-f]{40}$/i, "40자리 source SHA가 필요합니다.");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i, "64자리 SHA-256이 필요합니다.");
const jsonRecord = z.record(z.unknown());

const locale = z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, "BCP-47 locale이 필요합니다.");
const revisionRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/);
const numericId = z.string().regex(/^\d{1,30}$/, "숫자 provider ID가 필요합니다.");
const gcpProjectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "유효한 GCP project ID가 필요합니다.");
const region = z.string().regex(/^[a-z]+(?:-[a-z0-9]+)+\d$/, "유효한 cloud region이 필요합니다.");
const logicalCredentialId = z.string().regex(/^(?:shared|app)\/[A-Za-z0-9._/-]{1,180}$/);
const publicIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/);
const httpsUrl = z.string().url().max(2_048).refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:"
    && parsed.username === ""
    && parsed.password === ""
    && parsed.search === ""
    && parsed.hash === "";
}, {
  message: "userinfo, query, fragment가 없는 공개 HTTPS URL이 필요합니다.",
});
const httpsOrigin = z.string().url().max(512).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:"
    && !url.username
    && !url.password
    && url.pathname === "/"
    && !url.search
    && !url.hash;
}, "query/path/credential이 없는 정확한 HTTPS origin이 필요합니다.");
const githubReleaseAssetUrl = httpsUrl.refine((value) => {
  const parsed = new URL(value);
  return parsed.hostname === "github.com"
    && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^/]+\/[^/]+$/.test(parsed.pathname);
}, {
  message: "고정 GitHub Release asset URL이 필요합니다.",
});

const authorizationCredentialPattern = /\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/giu;
const directCredentialPatterns = [
  /-----BEGIN\s+(?:(?:RSA|EC|OPENSSH)\s+)?PRIVATE KEY-----/giu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bAIza[0-9A-Za-z_-]{20,}\b/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
] as const;
const labelledCredentialPattern = /\b((?:password|passwd|pwd|totp(?:[_-]?seed)?|otp(?:[_-]?seed)?|cookie|session(?:[_-]?(?:id|token))?|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*)(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s,;]{4,})/giu;
const opaqueCredentialPattern = /[A-Za-z0-9+/_=-]{32,}/gu;

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const result = pattern.test(value);
  pattern.lastIndex = 0;
  return result;
}

function isPublicOpaqueIdentifier(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function hasOpaqueCredentialCandidate(value: string): boolean {
  opaqueCredentialPattern.lastIndex = 0;
  for (const match of value.matchAll(opaqueCredentialPattern)) {
    if (!isPublicOpaqueIdentifier(match[0])) return true;
  }
  return false;
}

export function containsCredentialCandidate(value: string): boolean {
  return matches(authorizationCredentialPattern, value)
    || directCredentialPatterns.some((pattern) => matches(pattern, value))
    || matches(labelledCredentialPattern, value)
    || hasOpaqueCredentialCandidate(value);
}

export function redactCredentialCandidates(value: string): string {
  authorizationCredentialPattern.lastIndex = 0;
  let redacted = value.replace(authorizationCredentialPattern, "$1 [REDACTED]");
  for (const pattern of directCredentialPatterns) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  labelledCredentialPattern.lastIndex = 0;
  redacted = redacted.replace(labelledCredentialPattern, "$1[REDACTED]");
  opaqueCredentialPattern.lastIndex = 0;
  return redacted.replace(opaqueCredentialPattern, (candidate) => (
    isPublicOpaqueIdentifier(candidate) ? candidate : "[REDACTED]"
  ));
}

const market = z.enum(["google-play", "app-store", "apps-in-toss"]);
const platformArtifactKind = z.enum(["TYPESCRIPT", "GDSCRIPT"]);
const platformVersion = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const platformArtifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("TYPESCRIPT"),
    version: platformVersion,
    digest: sha256,
    packageName: z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/),
  }).strict(),
  z.object({
    kind: z.literal("GDSCRIPT"),
    version: platformVersion,
    digest: sha256,
    releaseAssetUrl: githubReleaseAssetUrl,
    treeChecksum: sha256,
  }).strict(),
]);

const platformCanaryRunSchema = z.object({
  runId: numericId,
  conclusion: z.literal("success"),
  headSha: sha40,
  workflowSourceSha: sha40,
}).strict();

export const platformCanaryEvidenceSchema = z.object({
  attestationSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  readbackKeyId: publicIdentifier,
  workflowBundle: z.object({
    repository: z.literal("seorilabs/.github"),
    sourceSha: sha40,
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict(),
  canaries: z.array(z.object({
    profile: z.enum(["godot", "react-native"]),
    repositoryId: numericId,
    repositoryFullName: z.string().regex(/^seorilabs\/[a-z0-9][a-z0-9._-]*$/),
    sourceSha: sha40,
    staticRun: platformCanaryRunSchema,
    buildOnlyRun: platformCanaryRunSchema.extend({
      cloudBuildId: publicIdentifier,
      builderImageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      buildConfigDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      artifact: z.object({
        name: z.string().regex(/^[A-Za-z0-9._-]+\.aab$/),
        sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        size: z.number().int().positive(),
      }).strict(),
    }).strict(),
  }).strict()).length(2),
}).strict().superRefine((evidence, context) => {
  if (evidence.canaries.map(({ profile }) => profile).join(",") !== "godot,react-native") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["canaries"], message: "canary 순서가 올바르지 않습니다." });
  }
  const repoIds = evidence.canaries.map(({ repositoryId }) => repositoryId);
  const repoNames = evidence.canaries.map(({ repositoryFullName }) => repositoryFullName);
  if (new Set(repoIds).size !== repoIds.length || new Set(repoNames).size !== repoNames.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["canaries"], message: "canary repository는 서로 달라야 합니다." });
  }
  evidence.canaries.forEach((canary, index) => {
    for (const [name, run] of [["staticRun", canary.staticRun], ["buildOnlyRun", canary.buildOnlyRun]] as const) {
      if (run.headSha.toLowerCase() !== canary.sourceSha.toLowerCase()
        || run.workflowSourceSha.toLowerCase() !== evidence.workflowBundle.sourceSha.toLowerCase()) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["canaries", index, name],
          message: "canary run의 exact source SHA가 일치하지 않습니다.",
        });
      }
    }
    if (canary.staticRun.runId === canary.buildOnlyRun.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canaries", index],
        message: "static과 build-only run은 서로 달라야 합니다.",
      });
    }
  });
});

export const platformReleaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  approval: z.literal("FLEET_APPROVED"),
  version: platformVersion,
  sourceSha: sha40,
  contractRevision: sha256,
  classification: z.enum(["IMPLEMENTATION_ONLY", "CONTRACT_CHANGE", "CONTRACT_ADDITION"]),
  publishedAt: z.string().datetime({ offset: true }),
  artifacts: z.array(platformArtifactSchema).min(1).max(2),
  canaryEvidence: platformCanaryEvidenceSchema,
  provenance: z.object({
    repository: z.literal("seorilabs/platform"),
    releaseId: numericId,
    releaseTag: z.string().regex(/^v\d+\.\d+\.\d+$/),
    rawManifestSha256: sha256,
    approvalSha256: sha256,
    approvalKeyId: publicIdentifier,
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const artifactKinds = manifest.artifacts.map((artifact) => artifact.kind);
  if (new Set(artifactKinds).size !== artifactKinds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts"], message: "artifact kind는 중복될 수 없습니다." });
  }
});

export const platformConsumerObservationPayloadSchema = z.discriminatedUnion("integration", [
  z.object({
    schemaVersion: z.literal(1),
    sourceSha: sha40,
    integration: z.literal("SDK"),
    artifactKind: platformArtifactKind,
    observedVersion: platformVersion,
    observedDigest: sha256.nullable(),
    contractRevision: sha256.nullable(),
    evidenceDigest: sha256.optional(),
    lockIntegrity: z.string().regex(/^(?:sha256-[A-Za-z0-9+/]{43}=|sha512-[A-Za-z0-9+/]{86}==)$/).optional(),
    releaseAssetUrl: githubReleaseAssetUrl.optional(),
    treeChecksum: sha256.optional(),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    sourceSha: sha40,
    integration: z.literal("CUSTOM_HTTP"),
    evidenceDigest: sha256,
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    sourceSha: sha40,
    integration: z.literal("MISSING"),
    evidenceDigest: sha256,
  }).strict(),
]);

export const platformFleetReconcileSchema = z.object({
  platformReleaseId: z.string().min(1).max(191),
  consumers: z.array(z.object({
    repoId: numericId,
    discoveryObservationId: z.string().min(1).max(191),
    providerObservationId: z.string().min(1).max(191),
  }).strict()).min(1).max(1_000),
}).strict().superRefine((input, context) => {
  const repoIds = input.consumers.map((consumer) => consumer.repoId);
  if (new Set(repoIds).size !== repoIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["consumers"], message: "consumer repo ID는 중복될 수 없습니다." });
  }
});

export const platformFleetTaskInputSchema = z.discriminatedUnion("kind", [
  z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("PLATFORM_SDK_UPDATE"),
    planId: z.string().min(1).max(191),
    repoId: numericId,
    repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    sourceSha: sha40,
    manifestDigest: sha256,
    releaseVersion: platformVersion,
    releaseSourceSha: sha40,
    contractRevision: sha256,
    artifact: platformArtifactSchema,
    pullRequestMarker: z.string().regex(/^<!-- seorilabs-platform-fleet:[0-9a-f]{64}:\d+ -->$/),
    requiredChecks: z.array(z.enum(["test:core", "check:architecture", "check:release", "repo-contract"])).min(1).max(4),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("PLATFORM_CONTRACT_ISSUE"),
    planId: z.string().min(1).max(191),
    repoId: numericId,
    repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    sourceSha: sha40,
    manifestDigest: sha256,
    releaseVersion: platformVersion,
    releaseSourceSha: sha40,
    contractRevision: sha256,
    classification: z.enum(["CONTRACT_CHANGE", "CONTRACT_ADDITION"]),
    artifact: platformArtifactSchema,
    issueMarker: z.string().regex(/^<!-- seorilabs-platform-fleet:[0-9a-f]{64}:\d+ -->$/),
    title: z.string().min(1).max(180).refine((value) => !containsCredentialCandidate(value)),
    body: z.string().min(1).max(20_000).refine((value) => !containsCredentialCandidate(value)),
    labels: z.tuple([
      z.literal("P1"),
      z.literal("autopilot"),
      z.literal("platform"),
      z.literal("platform-contract"),
    ]),
  }).strict(),
]);

export type PlatformReleaseManifest = z.infer<typeof platformReleaseManifestSchema>;
export type PlatformConsumerObservationPayload = z.infer<typeof platformConsumerObservationPayloadSchema>;
export type PlatformFleetTaskInput = z.infer<typeof platformFleetTaskInputSchema>;

/**
 * ProjectBlueprint는 provider에 쓸 비밀이 아니라 공개 식별자와 desired state만 보관한다.
 * credential은 logical ID로만 참조하며 API key, password, private key 필드는 strict schema가 거부한다.
 */
export const projectBlueprintSchema = z.object({
  schemaVersion: z.literal(1),
  organizationId: numericId,
  folderId: numericId,
  billingAccountId: z.string().regex(/^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/),
  project: z.object({
    projectId: gcpProjectId,
    projectNumber: numericId.optional(),
    region,
  }).strict(),
  apis: z.array(z.string().regex(/^[a-z0-9.-]+\.googleapis\.com$/)).max(100),
  iam: z.array(z.object({
    role: z.string().regex(/^roles\/[A-Za-z0-9_.]+$/),
    logicalPrincipalId: logicalCredentialId,
    publicIdentity: z.string().min(3).max(512),
  }).strict()).max(100),
  budget: z.object({
    currencyCode: z.enum(["KRW", "USD"]),
    monthlyAmount: z.number().positive().max(1_000_000_000),
    alertThresholds: z.array(z.number().positive().max(2)).min(1).max(10),
  }).strict(),
  firebase: z.object({
    authProviders: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)).max(30),
    appCheckEnforcement: z.enum(["OFF", "MONITOR", "ENFORCED"]),
    firestoreRulesChecksum: sha256,
    firestoreIndexesChecksum: sha256,
    storageRulesChecksum: sha256,
    functions: z.object({
      region,
      runtime: z.string().regex(/^nodejs\d{2}$/),
    }).strict(),
    apps: z.array(z.object({
      platform: z.enum(["ANDROID", "IOS", "WEB", "AIT"]),
      publicAppId: z.string().min(1).max(255).optional(),
      packageId: z.string().min(3).max(255).optional(),
      bundleId: z.string().min(3).max(255).optional(),
      aitAppName: z.string().min(1).max(191).optional(),
    }).strict()).min(1).max(4),
  }).strict(),
  analytics: z.object({
    ga4PropertyId: numericId.optional(),
    bigQueryProjectId: gcpProjectId,
    datasetId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/),
    location: z.string().regex(/^[A-Z][A-Z0-9-]{0,19}$/),
  }).strict(),
  workspace: z.object({
    groups: z.array(z.object({
      email: z.string().email().max(320),
      role: z.enum(["VIEWER", "OPERATOR", "ADMIN"]),
    }).strict()).max(100),
    domainWideDelegation: z.array(z.object({
      publicClientId: numericId,
      scopes: z.array(z.string().url().max(512)).min(1).max(100),
    }).strict()).max(20),
  }).strict(),
  provisioners: z.object({
    gcp: logicalCredentialId,
    firebase: logicalCredentialId,
    workspace: logicalCredentialId,
  }).strict(),
}).strict().superRefine((blueprint, context) => {
  const unique = (values: string[], path: (string | number)[]) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "중복 항목은 허용되지 않습니다.", path });
    }
  };
  unique(blueprint.apis, ["apis"]);
  unique(blueprint.iam.map((binding) => `${binding.role}:${binding.publicIdentity}`), ["iam"]);
  unique(blueprint.firebase.apps.map((app) => app.platform), ["firebase", "apps"]);
  unique(blueprint.workspace.groups.map((group) => group.email.toLowerCase()), ["workspace", "groups"]);
  unique(blueprint.budget.alertThresholds.map(String), ["budget", "alertThresholds"]);
  for (const [key, value] of Object.entries(blueprint.provisioners)) {
    if (!value.startsWith("shared/")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "공용 provisioner 기능에는 shared logical credential만 사용할 수 있습니다.",
        path: ["provisioners", key],
      });
    }
  }
  blueprint.firebase.apps.forEach((app, index) => {
    const valid = app.platform === "ANDROID"
      ? Boolean(app.packageId && !app.bundleId && !app.aitAppName)
      : app.platform === "IOS"
        ? Boolean(app.bundleId && !app.packageId && !app.aitAppName)
        : app.platform === "AIT"
          ? Boolean(app.aitAppName && !app.packageId && !app.bundleId)
          : !app.packageId && !app.bundleId && !app.aitAppName;
    if (!valid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Firebase app platform과 공개 식별자 조합이 일치하지 않습니다.",
        path: ["firebase", "apps", index],
      });
    }
  });
});

export type ProjectBlueprint = z.infer<typeof projectBlueprintSchema>;

export const complianceDraftSchema = z.object({
  market,
  declaration: z.enum([
    "data-safety",
    "privacy",
    "content-rating",
    "export-compliance",
    "review-notes",
  ]),
  state: z.literal("DRAFT"),
  draft: z.union([
    z.string().max(10_000),
    z.boolean(),
    z.record(z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()])),
  ]),
  evidenceRef: revisionRef.optional(),
}).strict();

/**
 * 첫 Fleet vertical slice가 자동 활성화할 수 있는 비민감 desired state의 완전한 목록이다.
 * strict object 밖의 값은 이름이나 중첩 위치와 무관하게 fail-closed한다.
 */
export const configRevisionPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  markets: z.array(z.object({
    market: z.enum(["google-play", "app-store", "apps-in-toss"]),
    enabled: z.boolean(),
    locales: z.array(locale).max(50),
    releaseChannel: z.enum(["internal", "private", "testflight"]).optional(),
  }).strict()).max(3),
  localizations: z.array(z.object({
    market: market.optional(),
    locale,
    displayName: z.string().min(1).max(50).optional(),
    subtitle: z.string().min(1).max(80).optional(),
    description: z.string().min(1).max(4_000).optional(),
    keywords: z.array(z.string().min(1).max(100)).max(20).optional(),
  }).strict()).max(50).optional(),
  assets: z.array(z.object({
    market: market.optional(),
    kind: z.enum(["icon", "feature-graphic", "thumbnail", "screenshot"]),
    locale: locale.optional(),
    objectKey: revisionRef,
    checksum: sha256,
  }).strict()).max(500).optional(),
  build: z.object({
    workflowBundleSha: sha40.optional(),
    platformVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/).optional(),
    minSdk: z.number().int().min(21).max(100).optional(),
    targetSdk: z.number().int().min(21).max(100).optional(),
  }).strict().optional(),
  support: z.object({
    supportUrl: httpsUrl.optional(),
    privacyPolicyUrl: httpsUrl.optional(),
  }).strict().optional(),
  projectBlueprint: projectBlueprintSchema.optional(),
  complianceDrafts: z.array(complianceDraftSchema).max(100).optional(),
}).strict().superRefine((payload, context) => {
  const seenMarkets = new Set<string>();
  const channelByMarket = {
    "google-play": "internal",
    "app-store": "testflight",
    "apps-in-toss": "private",
  } as const;
  payload.markets.forEach((market, marketIndex) => {
    if (seenMarkets.has(market.market)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "동일 market은 한 번만 선언할 수 있습니다.",
        path: ["markets", marketIndex, "market"],
      });
    }
    seenMarkets.add(market.market);
    const expectedChannel = channelByMarket[market.market];
    if (market.enabled && market.releaseChannel !== expectedChannel) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${market.market} enabled market의 releaseChannel은 ${expectedChannel}이어야 합니다.`,
        path: ["markets", marketIndex, "releaseChannel"],
      });
    }
    if (!market.enabled && market.releaseChannel !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "disabled market에는 releaseChannel을 선언할 수 없습니다.",
        path: ["markets", marketIndex, "releaseChannel"],
      });
    }
    if (new Set(market.locales).size !== market.locales.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "동일 market의 locale은 중복될 수 없습니다.",
        path: ["markets", marketIndex, "locales"],
      });
    }
  });
  const localizationLocales = payload.localizations?.map((item) => `${item.market ?? "all"}:${item.locale}`) ?? [];
  if (new Set(localizationLocales).size !== localizationLocales.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "동일 localization locale은 한 번만 선언할 수 있습니다.",
      path: ["localizations"],
    });
  }
  const assetKeys = payload.assets?.map((item) => (
    `${item.market ?? "all"}:${item.kind}:${item.locale ?? "all"}:${item.objectKey}`
  )) ?? [];
  if (new Set(assetKeys).size !== assetKeys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "동일 asset scope와 objectKey는 한 번만 선언할 수 있습니다.",
      path: ["assets"],
    });
  }
  const complianceKeys = payload.complianceDrafts?.map((item) => `${item.market}:${item.declaration}`) ?? [];
  if (new Set(complianceKeys).size !== complianceKeys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "동일 market declaration draft는 한 번만 선언할 수 있습니다.",
      path: ["complianceDrafts"],
    });
  }
  if (
    payload.build?.minSdk !== undefined
    && payload.build.targetSdk !== undefined
    && payload.build.minSdk > payload.build.targetSdk
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "minSdk는 targetSdk보다 클 수 없습니다.",
      path: ["build", "minSdk"],
    });
  }
});

const workflowWorkingDirectory = z.string().min(1).max(255).refine((value) => {
  if (value === ".") return true;
  return !value.startsWith("/")
    && !value.endsWith("/")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "repository 상대 workingDirectory가 필요합니다.");

export const workflowCallerSchema = z.discriminatedUnion("profile", [
  z.object({
    profile: z.literal("react-native"),
    packageManager: z.enum(["npm", "pnpm"]),
    workingDirectory: workflowWorkingDirectory,
  }).strict(),
  z.object({
    profile: z.literal("godot"),
    packageManager: z.null(),
    workingDirectory: workflowWorkingDirectory,
  }).strict(),
]);

export type WorkflowCaller = z.infer<typeof workflowCallerSchema>;

export const discoveryObservationSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  sourceSha: sha40,
  sourceRef: z.string().min(1).max(255).optional(),
  observedAt: z.coerce.date(),
  workflowCaller: workflowCallerSchema,
  payload: jsonRecord,
  buildTargets: z.array(z.object({
    targetKey: z.string().min(1).max(191),
    stack: z.string().min(1).max(191),
    market: z.string().min(1).max(64).optional(),
    packageId: z.string().min(1).max(255).optional(),
    bundleId: z.string().min(1).max(255).optional(),
    configuration: jsonRecord.optional(),
  })).default([]),
}).strict().superRefine((observation, context) => {
  const seenTargetKeys = new Set<string>();
  observation.buildTargets.forEach((target, targetIndex) => {
    if (seenTargetKeys.has(target.targetKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "동일 DiscoveryObservation의 targetKey는 중복될 수 없습니다.",
        path: ["buildTargets", targetIndex, "targetKey"],
      });
    }
    seenTargetKeys.add(target.targetKey);
  });
});

export const providerObservationSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  provider: z.string().min(1).max(64),
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(191),
  observedAt: z.coerce.date(),
  payload: jsonRecord,
  externalBinding: z.object({
    bindingType: z.string().min(1).max(64),
    externalId: z.string().min(1).max(191),
    publicIdentity: z.string().max(191).optional(),
    metadata: jsonRecord.optional(),
  }).strict().optional(),
}).strict();

export const providerReadbackPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  visibility: z.enum(["VISIBLE", "FORBIDDEN", "ERROR"]),
  state: z.enum(["PRESENT", "ABSENT", "UNKNOWN"]),
  publicIdentity: z.string().min(1).max(512).optional(),
  attributes: jsonRecord.default({}),
}).strict().superRefine((payload, context) => {
  if (payload.visibility !== "VISIBLE" && payload.state !== "UNKNOWN") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "권한 부족 또는 provider 오류는 리소스 부재로 기록할 수 없습니다.",
      path: ["state"],
    });
  }
});

export type ProviderReadbackPayload = z.infer<typeof providerReadbackPayloadSchema>;

export const marketReadbackSchema = z.object({
  schemaVersion: z.literal(1),
  market,
  publicAccountId: z.string().min(1).max(191),
  publicAppId: z.string().min(1).max(255),
  gate: z.enum(["UPLOAD", "PROCESSING", "DEVICE_QA", "REVIEW", "APPROVAL", "DEPLOYMENT", "PUBLIC"]),
  state: z.enum(["QUEUED", "IN_PROGRESS", "SUCCEEDED", "APPROVED", "LIVE", "FAILED", "REJECTED", "HUMAN_REQUIRED"]),
  sourceSha: sha40,
  configRevision: z.number().int().positive(),
  artifactChecksum: sha256,
  providerReference: z.string().min(1).max(512).optional(),
  observedAt: z.coerce.date(),
}).strict();

export type MarketReadback = z.infer<typeof marketReadbackSchema>;

const providerResourceSelector = z.object({
  provider: z.enum(["gcp", "firebase", "google-analytics", "bigquery", "google-workspace"]),
  resourceType: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  resourceId: z.string().min(1).max(191),
}).strict();

export const providerExecutionCreateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("BLUEPRINT_RESOURCE"),
    repoId: z.coerce.bigint().positive(),
    sourceSha: sha40,
    configRevision: z.number().int().positive(),
    operation: z.enum(["READBACK", "APPLY"]),
    resource: providerResourceSelector,
    maxAttempts: z.number().int().min(1).max(10).default(3),
  }).strict(),
  z.object({
    kind: z.literal("MARKET_RELEASE"),
    repoId: z.coerce.bigint().positive(),
    releaseCandidateId: z.string().min(1).max(191),
    operation: z.enum(["READBACK", "UPLOAD_INTERNAL"]),
    maxAttempts: z.number().int().min(1).max(10).default(3),
  }).strict(),
]);

export type ProviderExecutionCreate = z.infer<typeof providerExecutionCreateSchema>;

export const providerExecutionClaimSchema = z.object({
  workerId: z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/),
  leaseSeconds: z.number().int().min(30).max(300).default(300),
}).strict();

export const providerExecutionObservationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("BLUEPRINT"),
    observedAt: z.coerce.date(),
    payload: providerReadbackPayloadSchema,
  }).strict(),
  z.object({
    kind: z.literal("MARKET"),
    payload: marketReadbackSchema,
  }).strict(),
]);

export type ProviderExecutionObservation = z.infer<typeof providerExecutionObservationSchema>;

export const providerExecutionSettlementSchema = z.object({
  executionId: z.string().min(1).max(191),
  generation: z.number().int().positive(),
  leaseToken: z.string().min(32).max(256),
  outcome: z.enum(["COMMAND_ACCEPTED", "OBSERVED", "RESULT_UNKNOWN", "FAILED", "HUMAN_REQUIRED", "APPROVAL_REQUIRED"]),
  observation: providerExecutionObservationSchema.optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_.:-]{0,127}$/).optional(),
  reauthRequestId: publicIdentifier.optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome === "OBSERVED" && !value.observation) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "OBSERVED 결과에는 strict observation이 필요합니다.", path: ["observation"] });
  }
  if (value.outcome !== "OBSERVED" && value.observation) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "observation은 OBSERVED 결과에서만 허용합니다.", path: ["observation"] });
  }
  if (value.outcome === "FAILED" && !value.errorCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "FAILED 결과에는 공개 error code가 필요합니다.", path: ["errorCode"] });
  }
  if (value.outcome === "HUMAN_REQUIRED" && !value.reauthRequestId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "HUMAN_REQUIRED 결과에는 ReauthRequest 공개 ID가 필요합니다.", path: ["reauthRequestId"] });
  }
  if (value.outcome === "APPROVAL_REQUIRED" && !value.errorCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "APPROVAL_REQUIRED 결과에는 공개 error code가 필요합니다.", path: ["errorCode"] });
  }
});

export const providerCommandEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  executionId: publicIdentifier,
  generation: z.number().int().positive(),
  resumeMode: z.enum(["START", "READBACK_FIRST"]),
  adapterId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  operation: z.enum(["READBACK", "APPLY", "UPLOAD_INTERNAL"]),
  provider: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  origin: httpsOrigin,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  repoId: z.string().regex(/^\d{1,30}$/),
  sourceSha: sha40,
  configRevision: z.number().int().positive(),
  desiredHash: sha256,
  desired: jsonRecord,
  resource: z.object({
    type: z.string().min(1).max(64),
    id: z.string().min(1).max(191),
    environment: z.string().regex(/^[A-Za-z0-9._:/-]{1,64}$/),
    expectedPublicIdentity: z.string().min(1).max(512).nullable(),
  }).strict(),
  artifactChecksum: sha256.nullable(),
  credential: z.object({
    logicalId: logicalCredentialId,
    generation: z.number().int().positive(),
    policyGeneration: z.number().int().positive(),
    capability: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,190}$/),
    publicAccountId: z.string().min(1).max(191),
    publicIdentity: z.string().min(1).max(512),
    authFactors: z.array(z.enum(["api_key", "certificate", "oidc"])).min(1).max(3),
  }).strict(),
  approval: z.object({
    id: publicIdentifier,
    mode: z.enum(["preapproved", "per_run"]),
    expiresAt: z.string().datetime(),
    maxUses: z.literal(1),
  }).strict(),
  bindingHash: sha256,
}).strict();

export type ProviderCommandEnvelope = z.infer<typeof providerCommandEnvelopeSchema>;

export const releaseCandidateSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  sourceSha: sha40,
  configRevision: z.number().int().positive(),
  market,
  targetKey: z.string().min(1).max(191),
  artifactType: z.enum(["android-aab", "ios-archive", "ait-bundle", "web-bundle"]),
  artifactChecksum: sha256,
  workflowBundleSha: sha40,
  workflowBundleDigest: sha256,
  platformVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
}).strict();

export const RELEASE_GATE_NAMES = [
  "IMPLEMENTATION",
  "CI",
  "ARTIFACT",
  "RELEASE_ASSETS",
  "COMPLIANCE_DRAFT",
  "PROVIDER_SHELL",
  "UPLOAD",
  "PROCESSING",
  "DEVICE_QA",
  "REVIEW",
  "APPROVAL",
  "DEPLOYMENT",
  "PUBLIC",
] as const;

export const RELEASE_CANDIDATE_REQUIRED_GATES = RELEASE_GATE_NAMES.slice(0, 6);

export const releaseGateObservationSchema = z.object({
  candidateId: z.string().min(1).max(191),
  gate: z.enum(RELEASE_GATE_NAMES),
  status: z.enum(["PENDING", "PASSED", "FAILED", "HUMAN_REQUIRED"]),
  observedAt: z.coerce.date(),
  evidence: z.object({
    schemaVersion: z.literal(1),
    sourceSha: sha40,
    configRevision: z.number().int().positive(),
    artifactChecksum: sha256,
    providerReference: z.string().min(1).max(512).optional(),
    publicIdentity: z.string().min(1).max(512).optional(),
    note: z.string().max(2_000).optional(),
  }).strict(),
}).strict();

export type ReleaseGateName = typeof RELEASE_GATE_NAMES[number];

export const configRevisionSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  payload: configRevisionPayloadSchema,
}).strict();

export const desiredStateBackfillSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.literal("DRAFT_ONLY"),
}).strict();

const repositoryCandidateMarkerPath = z.string().min(1).max(512).refine((value) => (
  !value.startsWith("/")
  && !value.includes("\\")
  && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
), "안전한 repository candidate marker path가 필요합니다.");

export const repositoryClassificationDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  repoId: z.coerce.bigint().positive().max(BigInt(Number.MAX_SAFE_INTEGER)),
  expectedGeneration: z.number().int().nonnegative(),
  expectedDecisionRevision: z.number().int().nonnegative(),
  classification: z.enum(["PRODUCT_APP", "INFRA_REPO", "PLATFORM_PRODUCER", "EXCLUDED"]),
  candidateMarkerPath: repositoryCandidateMarkerPath.nullable(),
  justification: z.enum([
    "REPOSITORY_PURPOSE_CONFIRMED",
    "APP_CANDIDATE_SELECTED",
    "CENTRAL_POLICY_CORRECTION",
  ]),
}).strict().superRefine((value, context) => {
  if (value.classification !== "PRODUCT_APP" && value.candidateMarkerPath !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidateMarkerPath"],
      message: "PRODUCT_APP 외 분류에는 candidate marker를 지정할 수 없습니다.",
    });
  }
});

export type RepositoryClassificationDecisionRequest = z.infer<
  typeof repositoryClassificationDecisionSchema
>;

/**
 * Legacy shadow import는 원문이나 source path 목록을 호출자가 주입하지 못하게 한다.
 * 서버가 고정 allowlist와 transform version을 선택하고, 정확한 commit SHA에서만 읽는다.
 */
export const legacyShadowImportRequestSchema = z.object({
  repoId: z.coerce.bigint().positive().max(BigInt(Number.MAX_SAFE_INTEGER)),
  sourceSha: sha40,
}).strict();

export type LegacyShadowImportRequest = z.infer<typeof legacyShadowImportRequestSchema>;

export const configActivationSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  revision: z.number().int().positive(),
  expectedActiveRevision: z.number().int().nonnegative(),
}).strict();

export const reauthRequestSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  runId: z.string().min(1).max(191).optional(),
  provider: z.string().min(1).max(64),
  origin: httpsOrigin,
  publicAccountId: z.string().min(1).max(191),
  capability: z.string().min(1).max(191),
  gate: z.enum([
    "CAPTCHA",
    "PASSKEY",
    "SMS",
    "PUSH",
    "TRUSTED_DEVICE",
    "RECOVERY",
    "TERMS",
    "ANOMALOUS_LOGIN",
    "NEW_LOCATION",
    "HUMAN_MFA",
  ]),
}).strict();

export type ReauthGate = z.infer<typeof reauthRequestSchema>["gate"];

const REAUTH_PUBLIC_REASONS: Record<ReauthGate, string> = {
  CAPTCHA: "CAPTCHA는 사람이 trusted local UI에서 해결해야 합니다.",
  PASSKEY: "Passkey 인증은 사람이 trusted local UI에서 완료해야 합니다.",
  SMS: "SMS 인증은 사람이 trusted local UI에서 완료해야 합니다.",
  PUSH: "Push 승인은 사람이 trusted local UI에서 완료해야 합니다.",
  TRUSTED_DEVICE: "Trusted-device 확인은 사람이 trusted local UI에서 완료해야 합니다.",
  RECOVERY: "계정 복구는 사람이 trusted local UI에서 수행해야 합니다.",
  TERMS: "약관 확인과 동의는 사람이 trusted local UI에서 수행해야 합니다.",
  ANOMALOUS_LOGIN: "이상 로그인 확인은 사람이 trusted local UI에서 수행해야 합니다.",
  NEW_LOCATION: "새 위치 확인은 사람이 trusted local UI에서 수행해야 합니다.",
  HUMAN_MFA: "사람 소유 MFA는 trusted local UI에서 완료해야 합니다.",
};

export function reauthPublicReason(gate: ReauthGate): string {
  return REAUTH_PUBLIC_REASONS[gate];
}

export const agentClaimSchema = z.object({
  workerId: z.string().min(1).max(128),
  agentKind: z.enum(AUTOMATION_AGENT_KINDS),
  leaseSeconds: z.number().int().min(30).max(300).default(300),
}).strict();

export const agentResultSchema = z.object({
  outcomeCode: z.enum([
    "NO_CHANGES",
    "PR_READY",
    "ISSUE_RESOLVED",
    "READBACK_CONFIRMED",
    "RESULT_UNKNOWN",
    "BLOCKED",
  ]),
  summary: z.string().min(1).max(2_000).refine(
    (value) => !containsCredentialCandidate(value),
    "credential 후보가 없는 공개 summary가 필요합니다.",
  ),
  commitSha: sha40.optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  pullRequestUrl: httpsUrl.optional(),
  model: publicIdentifier.optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costMicros: z.number().int().nonnegative(),
  reauthRequestId: publicIdentifier.optional(),
}).strict().superRefine((result, context) => {
  for (const field of ["pullRequestUrl", "model", "reauthRequestId"] as const) {
    const value = result[field];
    if (value && containsCredentialCandidate(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "credential 후보가 없는 공개 값이 필요합니다.",
        path: [field],
      });
    }
  }
  if (result.outcomeCode === "PR_READY" && (!result.pullRequestNumber || !result.pullRequestUrl)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "PR_READY에는 pullRequestNumber와 pullRequestUrl이 필요합니다.",
      path: ["outcomeCode"],
    });
  }
  if (result.outcomeCode !== "PR_READY" && (result.pullRequestNumber || result.pullRequestUrl)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "PR 공개 식별자는 PR_READY 결과에만 허용합니다.",
      path: ["pullRequestNumber"],
    });
  }
});

export const agentLeaseActionSchema = z.object({
  runId: z.string().min(1).max(191),
  generation: z.number().int().positive(),
  leaseToken: z.string().min(32).max(256),
  leaseSeconds: z.number().int().min(30).max(300).default(300),
  result: agentResultSchema.optional(),
  error: z.string().regex(/^[A-Z][A-Z0-9_.:-]{0,127}$/, "공개 error code만 허용합니다.").optional(),
}).strict();

export const agentHeartbeatSchema = agentLeaseActionSchema.omit({ result: true, error: true });
export const agentCompletionSchema = agentLeaseActionSchema.extend({ result: agentResultSchema });
export const agentFailureSchema = agentLeaseActionSchema.extend({
  result: agentResultSchema,
  error: z.string().regex(/^[A-Z][A-Z0-9_.:-]{0,127}$/, "공개 error code만 허용합니다."),
});
export const agentReadbackRequiredSchema = agentLeaseActionSchema.extend({
  result: agentResultSchema,
}).superRefine((value, context) => {
  if (value.result.outcomeCode !== "RESULT_UNKNOWN") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "readback-required에는 RESULT_UNKNOWN outcomeCode가 필요합니다.",
      path: ["result", "outcomeCode"],
    });
  }
});

export const agentReadbackResolutionSchema = z.object({
  runId: z.string().min(1).max(191),
  generation: z.number().int().positive(),
  leaseToken: z.string().min(32).max(256),
  resolution: z.enum(["RESUME", "COMPLETE", "BLOCKED"]),
  result: agentResultSchema,
}).strict().superRefine((value, context) => {
  if (value.resolution === "RESUME" && value.result.outcomeCode !== "READBACK_CONFIRMED") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "RESUME resolution에는 READBACK_CONFIRMED outcomeCode가 필요합니다.",
      path: ["result", "outcomeCode"],
    });
  }
  if (value.resolution === "BLOCKED" && value.result.outcomeCode !== "BLOCKED") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "BLOCKED resolution에는 BLOCKED outcomeCode가 필요합니다.",
      path: ["result", "outcomeCode"],
    });
  }
});

export const automationDefinitionCreateSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  template: z.literal(AUTOMATION_TEMPLATE_KEY),
  agentKind: z.enum(AUTOMATION_AGENT_KINDS),
  cadence: z.enum(AUTOMATION_CADENCES),
  approvalPolicy: z.enum(AUTOMATION_APPROVAL_POLICIES).default("READY_PR"),
  budgetCeilingMicros: z.number().int().positive().max(1_000_000_000).default(1_000_000),
  model: publicIdentifier.optional(),
  maxAttempts: z.number().int().min(1).max(10).default(3),
}).strict();

export const automationDefinitionCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("PAUSE") }).strict(),
  z.object({ command: z.literal("RESUME") }).strict(),
  z.object({ command: z.literal("RUN_NOW") }).strict(),
  z.object({ command: z.literal("CANCEL_RUN"), runId: z.string().min(1).max(191) }).strict(),
  z.object({ command: z.literal("RETRY_RUN"), runId: z.string().min(1).max(191) }).strict(),
]);

export const fleetProjectFieldsSchema = z.object({
  priority: z.string().min(1).max(64).nullable(),
  app: z.string().min(1).max(191),
  kind: z.string().min(1).max(64),
  lifecycle: z.string().min(1).max(64),
  agent: z.string().min(1).max(64),
  approval: z.string().min(1).max(64),
  outcome: z.string().min(1).max(64),
}).strict();

export const sourceShaSchema = sha40;
export const artifactChecksumSchema = sha256;
