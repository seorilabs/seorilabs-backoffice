import { z } from "zod";

import type { AppOpsOperation } from "@/lib/app-ops/manifest";
import {
  isAppOpsRequestId,
  type AppOperationValues,
} from "@/lib/app-ops/operation";
import { platformOperationConfirmationText } from "@/lib/platform/confirmation";
import {
  PLATFORM_OPERATION_REASON_CODES,
  type PlatformOperationReason,
} from "@/lib/platform/reasons";

export {
  platformOperationConfirmationText,
  type PlatformConfirmationInput,
} from "@/lib/platform/confirmation";

export const PLATFORM_REPO_FULL_NAME = "seorilabs/platform";
export const PLATFORM_OUTCOME_UNKNOWN_CODE = "platform_outcome_unknown";

export const PLATFORM_OPERATION_KEYS = [
  "platform.iap.grant-entitlement",
  "platform.iap.revoke-entitlement",
  "platform.iap.reset-app-store-sandbox",
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

export const platformOperationInputSchema = z
  .discriminatedUnion("operation", [
    grantInputSchema,
    revokeInputSchema,
    resetInputSchema,
  ])
  .superRefine((input, ctx) => {
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
    if (input.serverConfirmation !== platformOperationConfirmationText(input)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serverConfirmation"],
        message: "서버 확인 문구가 요청 내용과 정확히 일치하지 않습니다.",
      });
    }
  });

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
  reason: PlatformOperationReason;
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
  return preparePlatformOperation({
    operation: input.operation,
    requestId: input.requestId,
    reason: input.reason,
    ...input.params,
  });
}

export function isPlatformWriteOperation(value: string): value is PlatformOperationKey {
  return isPlatformOperationKey(value);
}
