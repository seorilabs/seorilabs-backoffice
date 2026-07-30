import { z } from "zod";

import type {
  AppOpsManifest,
  AppOpsOperation,
  AppOpsTool,
} from "@/lib/app-ops/manifest";

export const APP_OPS_WORKFLOW_FILE = "backoffice-ops.yml";
export const APP_OPS_WORKFLOW_INPUTS = [
  "operation",
  "request_id",
  "target_ref",
  "reason",
] as const;
export const APP_OPS_RESULT_FILE = "result.json";
export const APP_OPS_ARTIFACT_PREFIX = "backoffice-ops-";

const MAX_TEXT_LENGTH = 512;
const MAX_TEXTAREA_LENGTH = 2_000;
const MAX_TARGET_REF_BYTES = 8 * 1024;
const MAX_REASON_LENGTH = 500;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AppOpsInputValue = string | number | boolean;
export type AppOpsInputValues = Record<string, AppOpsInputValue>;

export const appOpsResultSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().regex(REQUEST_ID),
    operation: z.string().min(3).max(129),
    status: z.enum(["success", "error"]),
    summary: z.string().trim().min(1).max(500),
    data: z.unknown().optional(),
    completedAt: z.string().datetime(),
  })
  .strict();

export type AppOpsResult = z.infer<typeof appOpsResultSchema>;

export function operationKey(toolId: string, operationId: string): string {
  return `${toolId}:${operationId}`;
}

export function typedConfirmationText(toolId: string, operationId: string): string {
  return operationKey(toolId, operationId);
}

export function findManifestOperation(
  manifest: AppOpsManifest,
  toolId: string,
  operationId: string,
): { tool: AppOpsTool; operation: AppOpsOperation } | null {
  const tool = manifest.tools.find((candidate) => candidate.id === toolId);
  const operation = tool?.operations.find((candidate) => candidate.id === operationId);
  return tool && operation ? { tool, operation } : null;
}

export function validateOperationInputs(
  operation: AppOpsOperation,
  raw: Record<string, unknown>,
): AppOpsInputValues {
  const allowed = new Set(operation.inputs.map((input) => input.key));
  const unexpected = Object.keys(raw).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`허용되지 않은 입력입니다: ${unexpected}`);
  }

  const values: AppOpsInputValues = {};
  for (const input of operation.inputs) {
    const value = raw[input.key];
    const missing = value === undefined || value === null || value === "";
    if (missing) {
      if (input.required) throw new Error(`${input.label} 입력이 필요합니다.`);
      continue;
    }

    if (input.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${input.label} 값은 boolean이어야 합니다.`);
      values[input.key] = value;
      continue;
    }
    if (input.type === "number") {
      const numberValue =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim()
            ? Number(value)
            : Number.NaN;
      if (!Number.isFinite(numberValue)) {
        throw new Error(`${input.label} 값은 유효한 숫자여야 합니다.`);
      }
      values[input.key] = numberValue;
      continue;
    }
    if (typeof value !== "string") throw new Error(`${input.label} 값은 문자열이어야 합니다.`);

    const normalized = value.trim();
    const maxLength = input.type === "textarea" ? MAX_TEXTAREA_LENGTH : MAX_TEXT_LENGTH;
    if (!normalized || normalized.length > maxLength) {
      throw new Error(`${input.label} 값의 길이가 올바르지 않습니다.`);
    }
    if (
      input.type === "select" &&
      !input.options?.some((option) => option.value === normalized)
    ) {
      throw new Error(`${input.label} 선택값이 허용 목록에 없습니다.`);
    }
    values[input.key] = normalized;
  }
  return values;
}

export function encodeTargetRef(values: AppOpsInputValues): string {
  const encoded = JSON.stringify(values);
  if (Buffer.byteLength(encoded, "utf8") > MAX_TARGET_REF_BYTES) {
    throw new Error("오퍼레이션 입력이 허용 크기를 초과했습니다.");
  }
  return encoded;
}

export function validateOperationConfirmation(options: {
  toolId: string;
  operation: AppOpsOperation;
  reason: string;
  typedConfirmation: string;
}): string {
  const reason = options.reason.trim();
  if (reason.length > MAX_REASON_LENGTH) throw new Error("변경 사유가 너무 깁니다.");
  if (options.operation.intent === "mutate" && !reason) {
    throw new Error("변경 오퍼레이션에는 사유가 필요합니다.");
  }
  if (
    options.operation.confirmation === "typed" &&
    options.typedConfirmation.trim() !==
      typedConfirmationText(options.toolId, options.operation.id)
  ) {
    throw new Error("재확인 문구가 일치하지 않습니다.");
  }
  return reason;
}

export function isAppOpsRequestId(value: string): boolean {
  return REQUEST_ID.test(value);
}

export function artifactName(requestId: string): string {
  return `${APP_OPS_ARTIFACT_PREFIX}${requestId}`;
}
