import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export { SOURCE_STATE_LABELS, sourceStateLabel } from "./collection-state";
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
  if (input.coverage && Array.isArray(input.coverage.versions)) {
    const current = await prisma.sourceCollectionRun.findUnique({ where: { id }, select: { coverage: true } });
    const before = (current?.coverage as { versions?: Array<{ uri: string; version: string }> } | null)?.versions ?? [];
    const merged = new Map(before.map((row) => [row.uri, row]));
    for (const row of input.coverage.versions as Array<{ uri: string; version: string }>) merged.set(row.uri, row);
    input.coverage = { ...input.coverage, versions: [...merged.values()] };
  }
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
