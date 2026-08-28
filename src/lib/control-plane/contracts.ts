import { z } from "zod";

const sha40 = z.string().regex(/^[0-9a-f]{40}$/i, "40자리 source SHA가 필요합니다.");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i, "64자리 SHA-256이 필요합니다.");
const jsonRecord = z.record(z.unknown());

const locale = z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, "BCP-47 locale이 필요합니다.");
const revisionRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/);
const numericId = z.string().regex(/^\d{1,30}$/, "숫자 provider ID가 필요합니다.");
const gcpProjectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "유효한 GCP project ID가 필요합니다.");
const region = z.string().regex(/^[a-z]+(?:-[a-z0-9]+)+\d$/, "유효한 cloud region이 필요합니다.");
const logicalCredentialId = z.string().regex(/^(?:shared|app)\/[A-Za-z0-9._/-]{1,180}$/);
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

const market = z.enum(["google-play", "app-store", "apps-in-toss"]);

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

export const workflowCallerSchema = z.object({
  profile: z.enum(["react-native", "godot"]),
  packageManager: z.enum(["npm", "pnpm"]),
  workingDirectory: workflowWorkingDirectory,
}).strict();

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

export const releaseCandidateSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  sourceSha: sha40,
  configRevision: z.number().int().positive(),
  market,
  targetKey: z.string().min(1).max(191),
  artifactType: z.enum(["android-aab", "ios-archive", "ait-bundle", "web-bundle"]),
  artifactChecksum: sha256,
  workflowBundleSha: sha40,
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

const httpsOrigin = z.string().url().max(512).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:"
    && !url.username
    && !url.password
    && url.pathname === "/"
    && !url.search
    && !url.hash;
}, "query/path/credential이 없는 정확한 HTTPS origin이 필요합니다.");

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
  leaseSeconds: z.number().int().min(30).max(300).default(300),
});

export const agentLeaseActionSchema = z.object({
  runId: z.string().min(1).max(191),
  generation: z.number().int().positive(),
  leaseToken: z.string().min(32).max(256),
  leaseSeconds: z.number().int().min(30).max(300).default(300),
  result: jsonRecord.optional(),
  error: z.string().max(16_000).optional(),
});

export const sourceShaSchema = sha40;
export const artifactChecksumSchema = sha256;
