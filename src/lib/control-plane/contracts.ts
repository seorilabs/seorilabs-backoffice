import { z } from "zod";

const sha40 = z.string().regex(/^[0-9a-f]{40}$/i, "40자리 source SHA가 필요합니다.");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i, "64자리 SHA-256이 필요합니다.");
const jsonRecord = z.record(z.unknown());

const locale = z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, "BCP-47 locale이 필요합니다.");
const revisionRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/);
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
    locale,
    displayName: z.string().min(1).max(50).optional(),
    subtitle: z.string().min(1).max(80).optional(),
    description: z.string().min(1).max(4_000).optional(),
    keywords: z.array(z.string().min(1).max(100)).max(20).optional(),
  }).strict()).max(50).optional(),
  assets: z.array(z.object({
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
  const localizationLocales = payload.localizations?.map((item) => item.locale) ?? [];
  if (new Set(localizationLocales).size !== localizationLocales.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "동일 localization locale은 한 번만 선언할 수 있습니다.",
      path: ["localizations"],
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
