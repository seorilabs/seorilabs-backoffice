import { z } from "zod";

import type { AppOpsOperation } from "@/lib/app-ops/manifest";
import {
  isAppOpsRequestId,
  type AppOperationValues,
} from "@/lib/app-ops/operation";
import {
  platformOperationConfirmationText,
  platformSandboxResetCloseConfirmationText,
  platformSandboxResetResumeConfirmationText,
} from "@/lib/platform/confirmation";
import {
  PLATFORM_OPERATION_REASON_CODES,
  type PlatformOperationReason,
} from "@/lib/platform/reasons";
import {
  PLATFORM_REFUND_REVIEW_PREFERENCES,
  PLATFORM_REFUND_REVIEW_REASONS,
  platformRefundReviewConfirmationText,
  type PlatformRefundReviewDecisionReason,
} from "@/lib/platform/refund-review";

export {
  platformOperationConfirmationText,
  type PlatformConfirmationInput,
} from "@/lib/platform/confirmation";
import {
  MAX_BLOCKED_VERSIONS,
  PLATFORM_UPDATE_POLICY_REASON_CODES,
  UPDATE_POLICY_PLATFORMS,
  splitVersions,
  type PlatformUpdatePolicyReason,
} from "@/lib/platform/update-policy";

export const PLATFORM_REPO_FULL_NAME = "seorilabs/platform";
export const PLATFORM_OUTCOME_UNKNOWN_CODE = "platform_outcome_unknown";
export const PLATFORM_SANDBOX_RESET_RESUME_MARKER = "resumePreparedReset";
export const PLATFORM_SANDBOX_RESET_CLOSE_MARKER = "closeNotStartedReset";
// PlatformClient의 20초 HTTP timeout과 DB 완료 저장을 포함할 실행 여유다.
// claim과 동일-ID 수동 retry가 같은 기준을 써야 만료 직전 row를 되열지 않는다.
export const PLATFORM_MIN_EXECUTION_WINDOW_MS = 60_000;

export const PLATFORM_OPERATION_KEYS = [
  "platform.iap.grant-entitlement",
  "platform.iap.revoke-entitlement",
  "platform.iap.reset-app-store-sandbox",
  "platform.iap.decide-refund-review",
  "platform.ads.grant-suppression",
  "platform.ads.revoke-suppression",
  "platform.config.set-update-policy",
] as const;

export type PlatformOperationKey = (typeof PLATFORM_OPERATION_KEYS)[number];

export class PlatformOperationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformOperationInputError";
  }
}

const commonInputs = [
  {
    key: "appSlug",
    label: "앱",
    type: "text",
    required: true,
  },
  {
    key: "platformUserId",
    label: "플랫폼 사용자 ID",
    type: "text",
    required: true,
  },
  {
    key: "entitlementId",
    label: "Entitlement ID",
    type: "text",
    required: true,
  },
  {
    key: "expectedEnvironment",
    label: "대상 환경",
    type: "select",
    required: true,
    options: [
      { value: "sandbox", label: "Sandbox" },
      { value: "production", label: "Production" },
    ],
  },
  {
    key: "serverConfirmation",
    label: "서버 확인 문구",
    type: "text",
    required: true,
  },
] satisfies AppOpsOperation["inputs"];

/**
 * 공통 플랫폼 write operation은 앱 저장소 manifest가 아니라 이 allowlist만 믿는다.
 * 저장소 관리자가 manifest를 바꿔도 플랫폼 원장을 조작할 권한은 생기지 않는다.
 */
export const PLATFORM_OPERATION_DEFINITIONS = {
  "platform.iap.grant-entitlement": {
    id: "grant-entitlement",
    label: "Entitlement 지급",
    description: "플랫폼 원장에 운영자 지급 source를 추가합니다.",
    intent: "mutate",
    risk: "high",
    confirmation: "typed",
    inputs: commonInputs,
  },
  "platform.iap.revoke-entitlement": {
    id: "revoke-entitlement",
    label: "Entitlement 회수",
    description: "지정한 운영자 지급 source를 취소 불가능하게 회수합니다.",
    intent: "mutate",
    risk: "high",
    confirmation: "typed",
    inputs: [
      ...commonInputs,
      {
        key: "grantRequestId",
        label: "원 지급 Request ID",
        type: "text",
        required: true,
      },
    ],
  },
  "platform.iap.reset-app-store-sandbox": {
    id: "reset-app-store-sandbox",
    label: "App Store Sandbox 원장 초기화",
    description:
      "App Store Connect 구매내역 삭제 후 플랫폼 sandbox 원장을 맞춥니다.",
    intent: "mutate",
    risk: "high",
    confirmation: "typed",
    inputs: [
      commonInputs[0],
      commonInputs[1],
      commonInputs[3],
      commonInputs[4],
      {
        key: "appleClearedConfirmed",
        label: "Apple 구매내역 삭제 확인",
        type: "boolean",
        required: true,
      },
    ],
  },
  "platform.iap.decide-refund-review": {
    id: "decide-refund-review",
    label: "Google Play 환불 검토 결정",
    description:
      "변경할 수 없는 환불 검토 의견을 플랫폼 worker 제출 queue에 확정합니다.",
    intent: "mutate",
    risk: "high",
    confirmation: "typed",
    inputs: [
      commonInputs[0],
      {
        key: "reviewId",
        label: "환불 검토 ID",
        type: "text",
        required: true,
      },
      commonInputs[3],
      {
        key: "refundPreference",
        label: "Google 제안",
        type: "select",
        required: true,
        options: PLATFORM_REFUND_REVIEW_PREFERENCES.map((value) => ({
          value,
          label: value,
        })),
      },
      {
        key: "sampleContentProvided",
        label: "샘플 콘텐츠 제공 여부",
        type: "boolean",
        required: true,
      },
      commonInputs[4],
    ],
  },
  "platform.ads.grant-suppression": {
    id: "grant-ads-suppression",
    label: "운영자 광고 차단 추가",
    description: "선택 사용자와 앱에 영구 운영자 광고 차단을 추가합니다.",
    intent: "mutate",
    risk: "high",
    confirmation: "typed",
    inputs: [commonInputs[0], commonInputs[1], commonInputs[4]],
  },
  "platform.ads.revoke-suppression": {
    id: "revoke-ads-suppression",
    label: "운영자 광고 차단 회수",
    description: "선택한 운영자 차단만 회수합니다. ad_free는 유지됩니다.",
    intent: "mutate",
    risk: "high",
    confirmation: "typed",
    inputs: [commonInputs[0], commonInputs[1], commonInputs[4], {
      key: "grantRequestId", label: "원 차단 Request ID", type: "text", required: true,
    }],
  },
  "platform.config.set-update-policy": {
    id: "set-update-policy",
    label: "업데이트 유도 정책",
    description:
      "권장 안내 기준과 강제 대상 버전을 저장합니다. 요청이 정책 전체를 대체합니다.",
    intent: "mutate",
    risk: "high",
    confirmation: "typed",
    inputs: [
      { key: "appSlug", label: "앱", type: "text", required: true },
      {
        key: "platforms",
        label: "대상 플랫폼",
        type: "text",
        required: true,
      },
      {
        key: "androidBlockedVersions",
        label: "Android 강제 대상",
        type: "text",
        required: false,
      },
      {
        key: "androidRecommendOverride",
        label: "Android 권장 기준 고정",
        type: "text",
        required: false,
      },
      {
        key: "iosBlockedVersions",
        label: "iOS 강제 대상",
        type: "text",
        required: false,
      },
      {
        key: "iosRecommendOverride",
        label: "iOS 권장 기준 고정",
        type: "text",
        required: false,
      },
      {
        key: "serverConfirmation",
        label: "서버 확인 문구",
        type: "text",
        required: false,
      },
    ],
  },
} satisfies Record<PlatformOperationKey, AppOpsOperation>;

const requestIdSchema = z.string().refine(isAppOpsRequestId, {
  message: "requestId는 UUID v4여야 합니다.",
});
const appSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    "appSlug 형식이 올바르지 않습니다.",
  );
const platformUserIdSchema = z
  .string()
  .regex(
    /^pu_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
    "platformUserId는 pu_ + ULID 형식이어야 합니다.",
  );
const entitlementIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9._-]{1,128}$/,
    "entitlementId 형식이 올바르지 않습니다.",
  );
const reasonSchema = z.enum(PLATFORM_OPERATION_REASON_CODES, {
  errorMap: () => ({ message: "허용된 변경 사유 코드를 선택해야 합니다." }),
});
const refundReviewReasonSchema = z.enum(PLATFORM_REFUND_REVIEW_REASONS, {
  errorMap: () => ({ message: "허용된 환불 검토 사유 코드를 선택해야 합니다." }),
});
const serverConfirmationSchema = z
  .string()
  .trim()
  .min(1, "서버 확인 문구가 필요합니다.")
  .max(300, "서버 확인 문구는 300자 이하여야 합니다.")
  .regex(
    /^[^\u0000-\u001F\u007F]+$/u,
    "서버 확인 문구는 한 줄이어야 합니다.",
  );

const commonShape = {
  requestId: requestIdSchema,
  appSlug: appSlugSchema,
  platformUserId: platformUserIdSchema,
  entitlementId: entitlementIdSchema,
  reason: reasonSchema,
  expectedEnvironment: z.enum(["sandbox", "production"]),
  serverConfirmation: serverConfirmationSchema,
};

const grantInputSchema = z
  .object({
    operation: z.literal("platform.iap.grant-entitlement"),
    ...commonShape,
  })
  .strict();

const revokeInputSchema = z
  .object({
    operation: z.literal("platform.iap.revoke-entitlement"),
    ...commonShape,
    grantRequestId: requestIdSchema,
  })
  .strict();

const resetInputSchema = z
  .object({
    operation: z.literal("platform.iap.reset-app-store-sandbox"),
    requestId: requestIdSchema,
    appSlug: appSlugSchema,
    platformUserId: platformUserIdSchema,
    reason: reasonSchema,
    expectedEnvironment: z.literal("sandbox"),
    serverConfirmation: serverConfirmationSchema,
    appleClearedConfirmed: z.literal(true),
  })
  .strict();

const refundReviewInputSchema = z
  .object({
    operation: z.literal("platform.iap.decide-refund-review"),
    requestId: requestIdSchema,
    appSlug: appSlugSchema,
    reviewId: z.string().regex(/^[0-9a-f]{64}$/, "reviewId 형식이 올바르지 않습니다."),
    expectedEnvironment: z.enum(["sandbox", "production"]),
    refundPreference: z.enum(PLATFORM_REFUND_REVIEW_PREFERENCES),
    sampleContentProvided: z.boolean(),
    reason: refundReviewReasonSchema,
    serverConfirmation: serverConfirmationSchema,
  })
  .strict();

const adsGrantInputSchema = z.object({
  operation: z.literal("platform.ads.grant-suppression"),
  requestId: requestIdSchema,
  appSlug: appSlugSchema,
  platformUserId: platformUserIdSchema,
  reason: reasonSchema,
  serverConfirmation: serverConfirmationSchema,
}).strict();

const adsRevokeInputSchema = z.object({
  operation: z.literal("platform.ads.revoke-suppression"),
  requestId: requestIdSchema,
  appSlug: appSlugSchema,
  platformUserId: platformUserIdSchema,
  grantRequestId: requestIdSchema,
  reason: reasonSchema,
  serverConfirmation: serverConfirmationSchema,
}).strict();

/**
 * 버전 목록은 쉼표 문자열이다. 큐 파라미터가 flat scalar만 담을 수 있다.
 *
 * 해석 불가한 값을 그대로 통과시키지 않는다. 서버가 어차피 거부하지만,
 * 여기서 막으면 운영자가 큐를 한 바퀴 돌기 전에 안다.
 */
const blockedVersionsSchema = z
  .string()
  .max(400)
  .regex(
    /^$|^v?\d{1,4}(\.\d{1,4}){0,2}(,v?\d{1,4}(\.\d{1,4}){0,2})*$/,
    "강제 대상은 쉼표로 구분한 안정 SemVer여야 합니다.",
  );
const recommendOverrideSchema = z
  .string()
  .max(32)
  .regex(
    /^$|^v?\d{1,4}(\.\d{1,4}){0,2}$/,
    "권장 기준 고정 값은 안정 SemVer여야 합니다.",
  );

const updatePolicyInputSchema = z
  .object({
    operation: z.literal("platform.config.set-update-policy"),
    requestId: requestIdSchema,
    appSlug: appSlugSchema,
    platforms: z
      .string()
      .regex(/^(android|ios)(,(android|ios))?$/, "대상 플랫폼이 올바르지 않습니다."),
    androidBlockedVersions: blockedVersionsSchema,
    androidRecommendOverride: recommendOverrideSchema,
    iosBlockedVersions: blockedVersionsSchema,
    iosRecommendOverride: recommendOverrideSchema,
    reason: z.enum(PLATFORM_UPDATE_POLICY_REASON_CODES, {
      errorMap: () => ({ message: "허용된 정책 변경 사유 코드를 선택해야 합니다." }),
    }),
    // 강제 대상을 새로 추가할 때만 필요하다. 해제와 권장 변경에는 없다.
    serverConfirmation: z.string().max(300),
  })
  .strict();

const sandboxResetResumeInputSchema = z
  .object({
    requestId: requestIdSchema,
    operation: z.literal("platform.iap.reset-app-store-sandbox"),
    appSlug: appSlugSchema,
    serverConfirmation: serverConfirmationSchema,
    resumePreparedReset: z.literal(true),
    reason: z.null(),
  })
  .strict();

const sandboxResetCloseInputSchema = z
  .object({
    requestId: requestIdSchema,
    operation: z.literal("platform.iap.reset-app-store-sandbox"),
    appSlug: appSlugSchema,
    serverConfirmation: serverConfirmationSchema,
    closeNotStartedReset: z.literal(true),
    reason: z.null(),
  })
  .strict();

export const platformOperationInputSchema = z
  .discriminatedUnion("operation", [
    grantInputSchema,
    revokeInputSchema,
    resetInputSchema,
    refundReviewInputSchema,
    adsGrantInputSchema,
    adsRevokeInputSchema,
    updatePolicyInputSchema,
  ])
  .superRefine((input, ctx) => {
    // 정책 조작은 확인 문구 규칙이 다르다. 강제 대상을 새로 추가할 때만
    // 필요하고, 그 판단에는 현재 정책이 있어야 해서 서버 액션이 계산한다.
    if (input.operation === "platform.config.set-update-policy") {
      validateUpdatePolicyInput(input, ctx);
      return;
    }
    if (
      input.operation === "platform.iap.revoke-entitlement" &&
      input.grantRequestId === input.requestId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["grantRequestId"],
        message: "회수 requestId와 원 지급 requestId는 달라야 합니다.",
      });
    }
    const expectedConfirmation =
      input.operation === "platform.iap.decide-refund-review"
        ? platformRefundReviewConfirmationText(input)
        : platformOperationConfirmationText(input);
    if (input.serverConfirmation !== expectedConfirmation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serverConfirmation"],
        message: "서버 확인 문구가 요청 내용과 정확히 일치하지 않습니다.",
      });
    }
  });

/**
 * 대상 플랫폼과 값의 짝을 검증한다.
 *
 * discriminatedUnion 멤버는 ZodObject여야 해서 여기서 검사한다.
 */
function validateUpdatePolicyInput(
  input: {
    platforms: string;
    androidBlockedVersions: string;
    androidRecommendOverride: string;
    iosBlockedVersions: string;
    iosRecommendOverride: string;
  },
  ctx: z.RefinementCtx,
): void {
  const invalid = (message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["platforms"], message });

  const selected = input.platforms.split(",");
  if (new Set(selected).size !== selected.length) {
    invalid("대상 플랫폼이 중복됐습니다.");
  }

  for (const platform of UPDATE_POLICY_PLATFORMS) {
    const blocked =
      platform === "android"
        ? input.androidBlockedVersions
        : input.iosBlockedVersions;
    const override =
      platform === "android"
        ? input.androidRecommendOverride
        : input.iosRecommendOverride;

    if (!selected.includes(platform)) {
      // 대상에서 뺀 플랫폼의 값이 남아 있으면 운영자가 의도를 잘못 안 것이다.
      if (blocked !== "" || override !== "") {
        invalid(`${platform}을 대상에 넣지 않았는데 값이 있습니다.`);
      }
      continue;
    }

    const versions = splitVersions(blocked);
    if (versions.length > MAX_BLOCKED_VERSIONS) {
      invalid(`한 플랫폼에서 강제할 수 있는 버전은 최대 ${MAX_BLOCKED_VERSIONS}개입니다.`);
    }
    const seen = new Set<string>();
    for (const version of versions) {
      const key = version.replace(/^v/i, "");
      if (seen.has(key)) invalid(`강제 대상 버전이 중복됐습니다: ${version}`);
      seen.add(key);
    }
  }
}

export type PlatformOperationInput = z.infer<
  typeof platformOperationInputSchema
>;

export interface PreparedPlatformOperation {
  requestId: string;
  appSlug: string;
  operation: AppOpsOperation;
  operationKey: PlatformOperationKey;
  params: AppOperationValues;
  paramsJson: string;
  reason:
    | PlatformOperationReason
    | PlatformRefundReviewDecisionReason
    | PlatformUpdatePolicyReason;
}

export interface PreparedSandboxResetResume {
  requestId: string;
  appSlug: string;
  serverConfirmation: string;
}

export interface PreparedSandboxResetClose {
  requestId: string;
  appSlug: string;
  serverConfirmation: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlatformOperationKey(value: unknown): value is PlatformOperationKey {
  return (
    typeof value === "string" &&
    (PLATFORM_OPERATION_KEYS as readonly string[]).includes(value)
  );
}

/** 고정 allowlist와 각 필드 규격을 모두 통과한 write 요청만 큐 입력으로 만든다. */
export function preparePlatformOperation(
  input: unknown,
): PreparedPlatformOperation {
  if (!isRecord(input) || !isPlatformOperationKey(input.operation)) {
    throw new PlatformOperationInputError(
      "허용되지 않은 플랫폼 오퍼레이션입니다.",
    );
  }

  const parsed = platformOperationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PlatformOperationInputError(
      parsed.error.issues[0]?.message ??
        "플랫폼 오퍼레이션 입력이 올바르지 않습니다.",
    );
  }

  const { requestId, operation, reason, appSlug, ...operationParams } =
    parsed.data;
  const params: AppOperationValues = { appSlug, ...operationParams };

  return {
    requestId,
    appSlug,
    operation: PLATFORM_OPERATION_DEFINITIONS[operation],
    operationKey: operation,
    params,
    paramsJson: JSON.stringify(params),
    reason,
  };
}

/** DB에서 꺼낸 값도 외부 입력으로 보고 worker 실행 직전에 다시 검증한다. */
export function prepareQueuedPlatformOperation(input: {
  requestId: string;
  operation: string;
  params: unknown;
  reason: string | null;
}): PreparedPlatformOperation {
  if (!isRecord(input.params)) {
    throw new PlatformOperationInputError(
      "플랫폼 오퍼레이션 params가 올바르지 않습니다.",
    );
  }

  // requestId·operation·reason은 AppOperationRun envelope가 원장이다.
  // params에 같은 키가 있으면 손상/직접 삽입 row가 다른 멱등 키나 조작으로
  // 실행될 수 있으므로 덮어쓰기 순서에 기대지 않고 명시적으로 거부한다.
  for (const reservedKey of ["requestId", "operation", "reason"] as const) {
    if (Object.prototype.hasOwnProperty.call(input.params, reservedKey)) {
      throw new PlatformOperationInputError(
        `플랫폼 오퍼레이션 params에 예약 필드 ${reservedKey}를 넣을 수 없습니다.`,
      );
    }
  }
  return preparePlatformOperation({
    ...input.params,
    operation: input.operation,
    requestId: input.requestId,
    reason: input.reason,
  });
}

/**
 * TTL 뒤 민감 payload가 제거된 durable reset만 별도 최소 envelope로 재개한다.
 * marker가 없는 일반 요청은 null을 반환하고 기존 strict parser가 처리한다.
 */
export function prepareQueuedSandboxResetResume(input: {
  requestId: string;
  operation: string;
  params: unknown;
  reason: string | null;
}): PreparedSandboxResetResume | null {
  if (
    !isRecord(input.params) ||
    input.params[PLATFORM_SANDBOX_RESET_RESUME_MARKER] !== true
  ) {
    return null;
  }
  for (const reservedKey of ["requestId", "operation", "reason"] as const) {
    if (Object.prototype.hasOwnProperty.call(input.params, reservedKey)) {
      throw new PlatformOperationInputError(
        `sandbox reset 재개 params에 예약 필드 ${reservedKey}를 넣을 수 없습니다.`,
      );
    }
  }
  const parsed = sandboxResetResumeInputSchema.safeParse({
    requestId: input.requestId,
    operation: input.operation,
    ...input.params,
    reason: input.reason,
  });
  if (!parsed.success) {
    throw new PlatformOperationInputError(
      parsed.error.issues[0]?.message ??
        "sandbox reset 재개 입력이 올바르지 않습니다.",
    );
  }
  const expected = platformSandboxResetResumeConfirmationText({
    appSlug: parsed.data.appSlug,
    requestId: parsed.data.requestId,
  });
  if (parsed.data.serverConfirmation !== expected) {
    throw new PlatformOperationInputError(
      "sandbox reset 재개 확인 문구가 정확히 일치하지 않습니다.",
    );
  }
  return {
    requestId: parsed.data.requestId,
    appSlug: parsed.data.appSlug,
    serverConfirmation: parsed.data.serverConfirmation,
  };
}

/**
 * TTL 뒤 원 payload 없이 permanent not-started closure만 실행하는 envelope다.
 * resume와 marker를 분리해 worker가 잘못된 원격 endpoint를 선택하지 않게 한다.
 */
export function prepareQueuedSandboxResetClose(input: {
  requestId: string;
  operation: string;
  params: unknown;
  reason: string | null;
}): PreparedSandboxResetClose | null {
  if (
    !isRecord(input.params) ||
    input.params[PLATFORM_SANDBOX_RESET_CLOSE_MARKER] !== true
  ) {
    return null;
  }
  for (const reservedKey of ["requestId", "operation", "reason"] as const) {
    if (Object.prototype.hasOwnProperty.call(input.params, reservedKey)) {
      throw new PlatformOperationInputError(
        `sandbox reset 미시작 종료 params에 예약 필드 ${reservedKey}를 넣을 수 없습니다.`,
      );
    }
  }
  const parsed = sandboxResetCloseInputSchema.safeParse({
    requestId: input.requestId,
    operation: input.operation,
    ...input.params,
    reason: input.reason,
  });
  if (!parsed.success) {
    throw new PlatformOperationInputError(
      parsed.error.issues[0]?.message ??
        "sandbox reset 미시작 종료 입력이 올바르지 않습니다.",
    );
  }
  const expected = platformSandboxResetCloseConfirmationText({
    appSlug: parsed.data.appSlug,
    requestId: parsed.data.requestId,
  });
  if (parsed.data.serverConfirmation !== expected) {
    throw new PlatformOperationInputError(
      "sandbox reset 미시작 종료 확인 문구가 정확히 일치하지 않습니다.",
    );
  }
  return {
    requestId: parsed.data.requestId,
    appSlug: parsed.data.appSlug,
    serverConfirmation: parsed.data.serverConfirmation,
  };
}

/** worker 권한 재검증 단계도 일반 command와 resume envelope를 모두 엄격히 읽는다. */
export function queuedPlatformOperationAppSlug(input: {
  requestId: string;
  operation: string;
  params: unknown;
  reason: string | null;
}): string {
  return (
    prepareQueuedSandboxResetResume(input)?.appSlug ??
    prepareQueuedSandboxResetClose(input)?.appSlug ??
    prepareQueuedPlatformOperation(input).appSlug
  );
}

export function isPlatformWriteOperation(value: string): value is PlatformOperationKey {
  return isPlatformOperationKey(value);
}
