import { strFromU8, unzipSync } from "fflate";

import {
  APP_OPS_RESULT_FILE,
  appOpsResultSchema,
  type AppOpsResult,
} from "@/lib/app-ops/operation";

const MAX_RESULT_BYTES = 64 * 1024;

export function parseAppOpsResultArtifact(
  zipBytes: Uint8Array,
  requestId: string,
): AppOpsResult {
  const files = unzipSync(zipBytes);
  const resultBytes = files[APP_OPS_RESULT_FILE];
  if (!resultBytes) throw new Error(`${APP_OPS_RESULT_FILE}이 artifact에 없습니다.`);
  if (resultBytes.byteLength > MAX_RESULT_BYTES) {
    throw new Error("결과 JSON이 허용 크기를 초과했습니다.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(resultBytes));
  } catch {
    throw new Error("결과 JSON이 올바르지 않습니다.");
  }
  const result = appOpsResultSchema.safeParse(parsed);
  if (!result.success) throw new Error("결과 JSON 계약이 올바르지 않습니다.");
  if (result.data.requestId !== requestId) throw new Error("결과 요청 ID가 일치하지 않습니다.");
  return result.data;
}
