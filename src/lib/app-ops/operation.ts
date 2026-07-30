import {
  parseAppOpsManifest,
  type AppOpsInput,
  type AppOpsOperation,
} from "@/lib/app-ops/manifest";

export const APP_OPS_WORKFLOW_FILE = "backoffice-ops.yml";
export const APP_OPS_WORKFLOW_NAME = "Backoffice Operations";

export type AppOperationValue = string | number | boolean;
export type AppOperationValues = Record<string, AppOperationValue>;

export interface PreparedAppOperation {
  operation: AppOpsOperation;
  operationKey: string;
  params: AppOperationValues;
  paramsJson: string;
  reason: string | null;
}

function isMissing(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function normalizeInput(input: AppOpsInput, value: unknown): AppOperationValue | undefined {
  if (isMissing(value)) {
    if (input.required) throw new Error(`${input.label} 입력이 필요합니다.`);
    return undefined;
  }

  if (input.type === "number") {
    const numberValue =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(numberValue)) {
      throw new Error(`${input.label}은 숫자여야 합니다.`);
    }
    return numberValue;
  }

  if (input.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`${input.label}은 true 또는 false여야 합니다.`);
  }

  if (typeof value !== "string") {
    throw new Error(`${input.label}은 문자열이어야 합니다.`);
  }
  const stringValue = value.trim();
  if (stringValue.length > 2_000) {
    throw new Error(`${input.label}은 2,000자 이하여야 합니다.`);
  }
  if (
    input.type === "select" &&
    !input.options?.some((option) => option.value === stringValue)
  ) {
    throw new Error(`${input.label}의 허용되지 않은 값입니다.`);
  }
  return stringValue;
}

export function prepareAppOperation(input: {
  manifestValue: unknown;
  toolId: string;
  operationId: string;
  values?: Record<string, unknown>;
  reason?: string;
  confirmationText?: string;
}): PreparedAppOperation {
  const { manifest, error } = parseAppOpsManifest(input.manifestValue);
  if (!manifest) {
    throw new Error(error ? `관리툴 manifest 오류: ${error}` : "관리툴 manifest가 없습니다.");
  }

  const tool = manifest.tools.find((candidate) => candidate.id === input.toolId);
  if (!tool) throw new Error("관리 도구를 찾을 수 없습니다.");
  const operation = tool.operations.find(
    (candidate) => candidate.id === input.operationId,
  );
  if (!operation) throw new Error("오퍼레이션을 찾을 수 없습니다.");

  const rawValues = input.values ?? {};
  const inputKeys = new Set(operation.inputs.map((item) => item.key));
  const unknownKey = Object.keys(rawValues).find((key) => !inputKeys.has(key));
  if (unknownKey) throw new Error(`선언되지 않은 입력입니다: ${unknownKey}`);

  const params: AppOperationValues = {};
  for (const definition of operation.inputs) {
    const value = normalizeInput(definition, rawValues[definition.key]);
    if (value !== undefined) params[definition.key] = value;
  }

  const reason = input.reason?.trim() ?? "";
  if (reason.length > 500) throw new Error("변경 사유는 500자 이하여야 합니다.");
  if (operation.intent === "mutate" && !reason) {
    throw new Error("변경 오퍼레이션에는 사유가 필요합니다.");
  }
  if (
    operation.confirmation === "typed" &&
    input.confirmationText?.trim() !== operation.label
  ) {
    throw new Error(`확인 문구로 "${operation.label}"을 입력하세요.`);
  }

  const paramsJson = JSON.stringify(params);
  if (Buffer.byteLength(paramsJson, "utf8") > 8_000) {
    throw new Error("오퍼레이션 입력은 합계 8,000바이트 이하여야 합니다.");
  }

  return {
    operation,
    operationKey: `${tool.id}.${operation.id}`,
    params,
    paramsJson,
    reason: reason || null,
  };
}
