import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const SOURCE_STATE_LABELS: Record<string, string> = {
  observed: "수집됨",
  empty: "자료 없음",
  not_landed: "아직 도착하지 않음",
  failed: "수집 실패",
  needs_input: "설정·권한 필요",
  not_applicable: "대상 아님",
  running: "수집 중",
  partial: "일부 수집됨",
  stale: "수집 지연",
};
export function sourceStateLabel(state: string) {
  return SOURCE_STATE_LABELS[state] ?? "확인 필요";
}
export function collectionErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/403|권한|자격증명|미설정|401/.test(message)) return "SOURCE_PERMISSION_REQUIRED";
  if (/429/.test(message)) return "SOURCE_RATE_LIMITED";
  if (/응답 본문 없음/.test(message)) return "SOURCE_EMPTY_RESPONSE";
  if (/JSON|형식/.test(message)) return "SOURCE_RESPONSE_INVALID";
  if (/timeout|시간|abort/i.test(message)) return "SOURCE_TIMEOUT";
  return "SOURCE_COLLECTION_FAILED";
}
export function collectionTarget(value: string) {
  return value.length <= 191
    ? value
    : value.slice(0, 100) + ":" + createHash("sha256").update(value).digest("hex");
}
export async function beginCollection(source: string, target: string, appId?: string) {
  return prisma.sourceCollectionRun.create({
    data: { source, target: collectionTarget(target), appId, status: "running" },
    select: { id: true },
  });
}
export async function completeCollection(
  id: string,
  input: {
    status: string;
    dataThrough?: Date;
    coverage?: Prisma.InputJsonObject;
    errorCode?: string;
  },
) {
  await prisma.sourceCollectionRun.update({
    where: { id },
    data: { ...input, completedAt: new Date() },
  });
}
export async function observedCollection<T>(
  input: { source: string; target: string; appId?: string },
  run: () => Promise<{ value: T; count: number; dataThrough?: Date }>,
): Promise<T> {
  const started = await beginCollection(input.source, input.target, input.appId);
  try {
    const result = await run();
    await completeCollection(started.id, {
      status: result.count ? "observed" : "empty",
      dataThrough: result.dataThrough ?? new Date(),
      coverage: { observations: result.count },
    });
    return result.value;
  } catch (error) {
    const errorCode = collectionErrorCode(error);
    await completeCollection(started.id, {
      status: errorCode === "SOURCE_PERMISSION_REQUIRED" ? "needs_input" : "failed",
      errorCode,
    });
    throw error;
  }
}
