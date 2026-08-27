import { z } from "zod";

const sha40 = z.string().regex(/^[0-9a-f]{40}$/i, "40자리 source SHA가 필요합니다.");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i, "64자리 SHA-256이 필요합니다.");
const jsonRecord = z.record(z.unknown());

export interface HumanOnlyConfigField {
  path: string;
  reason: string;
}

const HUMAN_ONLY_KEYS = new Map<string, string>([
  ["legaldeclaration", "법적 선언"],
  ["legaldeclarations", "법적 선언"],
  ["legal", "법적 선언"],
  ["termsacceptance", "약관 동의"],
  ["accountowner", "계정 소유권"],
  ["accountownership", "계정 소유권"],
  ["ownership", "계정 소유권"],
  ["ownershipverification", "계정 소유권"],
  ["billing", "결제 정보"],
  ["billingaccount", "결제 정보"],
  ["payment", "결제 정보"],
  ["paymentprofile", "결제 정보"],
  ["tax", "세금 정보"],
  ["taxes", "세금 정보"],
  ["bank", "은행 정보"],
  ["banking", "은행 정보"],
  ["contract", "계약 정보"],
  ["contracts", "계약 정보"],
  ["reviewsubmission", "심사 제출"],
  ["submitforreview", "심사 제출"],
  ["reviewsubmit", "심사 제출"],
  ["publicrelease", "공개 배포"],
  ["publicdeployment", "공개 배포"],
  ["publicrollout", "공개 배포"],
  ["productiontrack", "공개 배포"],
  ["credential", "자격증명 변경"],
  ["credentials", "자격증명 변경"],
  ["credentialbinding", "자격증명 변경"],
  ["credentialbindings", "자격증명 변경"],
  ["secret", "자격증명 변경"],
  ["secrets", "자격증명 변경"],
  ["password", "자격증명 변경"],
  ["totp", "자격증명 변경"],
  ["cookie", "자격증명 변경"],
  ["cookies", "자격증명 변경"],
  ["recoverycode", "자격증명 변경"],
  ["apikey", "자격증명 변경"],
  ["apikeys", "자격증명 변경"],
  ["certificate", "자격증명 변경"],
  ["certificates", "자격증명 변경"],
]);

const HUMAN_ONLY_KEY_PATTERNS: Array<[RegExp, string]> = [
  [/legal.*declaration/, "법적 선언"],
  [/(account.*owner|owner.*account|ownership.*verification)/, "계정 소유권"],
  [/^(billing|billingaccount|payment|payments|paymentprofile|paymentsettings|paymentaccount)/, "결제 정보"],
  [/^(tax|taxes|taxinfo|taxprofile|taxsettings|taxdetails|taxid|taxform|bank|banking|bankaccount|bankinfo)$/, "세금·은행 정보"],
  [/^(legalcontract|commercialcontract|contractacceptance|contractsignature|contractterms)$/, "계약 정보"],
  [/(review.*submit|submit.*review|review.*submission)/, "심사 제출"],
  [/(public.*release|public.*deploy|public.*rollout|production.*track)/, "공개 배포"],
  [/(credential|secret|password|totp|cookie|recovery.*code|api.*key|certificate)/, "자격증명 변경"],
];

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function humanOnlyReason(key: string): string | undefined {
  const normalized = normalizedKey(key);
  return HUMAN_ONLY_KEYS.get(normalized)
    ?? HUMAN_ONLY_KEY_PATTERNS.find(([pattern]) => pattern.test(normalized))?.[1];
}

/**
 * ConfigRevision은 비민감 desired state만 담는다. 사람 전용 변경은 별도 승인
 * workflow가 생기기 전까지 UI와 internal API 양쪽에서 같은 validator로 거부한다.
 */
export function humanOnlyConfigFields(value: unknown): HumanOnlyConfigField[] {
  const findings: HumanOnlyConfigField[] = [];
  const visit = (node: unknown, path: Array<string | number>) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const nextPath = [...path, key];
      const reason = humanOnlyReason(key);
      if (reason) findings.push({ path: nextPath.join("."), reason });
      visit(child, nextPath);
    }
  };
  visit(value, []);
  return findings;
}

export const configRevisionPayloadSchema = jsonRecord.superRefine((payload, context) => {
  for (const finding of humanOnlyConfigFields(payload)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${finding.reason} 필드 '${finding.path}'는 별도 사람 승인 workflow가 필요합니다.`,
      path: finding.path.split("."),
      params: { controlPlaneCode: "HUMAN_APPROVAL_REQUIRED" },
    });
  }
});

export const discoveryObservationSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  sourceSha: sha40,
  sourceRef: z.string().min(1).max(255).optional(),
  observedAt: z.coerce.date(),
  payload: jsonRecord,
  buildTargets: z.array(z.object({
    targetKey: z.string().min(1).max(191),
    stack: z.string().min(1).max(191),
    market: z.string().min(1).max(64).optional(),
    packageId: z.string().min(1).max(255).optional(),
    bundleId: z.string().min(1).max(255).optional(),
    configuration: jsonRecord.optional(),
  })).default([]),
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
  }).optional(),
});

export const configRevisionSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  payload: configRevisionPayloadSchema,
}).strict();

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
  reason: z.string().min(1).max(1_000),
}).strict();

export const trustedLocalPendingSchema = z.object({
  repoId: z.coerce.bigint().positive(),
  reauthRequestId: z.string().min(1).max(191),
  expectedGeneration: z.number().int().nonnegative(),
}).strict();

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
