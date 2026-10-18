import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AnalyticsConnection } from "./source-contract";

export interface InstanceCompletion { uri: string; version: string; savedStart: string; savedEnd: string; maxDay: string | null; through: string | null }
export async function completedInstance(appId: string, connection: AnalyticsConnection, uri: string, version: string, start: string, end: string) {
  const scope = JSON.stringify({ accountId: connection.accountId, resourceId: connection.resourceId, credentialId: connection.credentialId, timeZone: connection.timeZone });
  const match = JSON.stringify({ uri, version });
  const runs = await prisma.$queryRaw<Array<{ coverage: { instances?: InstanceCompletion[] } }>>(Prisma.sql`
    SELECT coverage FROM source_collection_run WHERE appId = ${appId} AND source = ${connection.source}
      AND JSON_CONTAINS(coverage, ${scope}) AND JSON_CONTAINS(coverage, ${match}, '$.instances')
    ORDER BY startedAt DESC, id DESC`);
  return runs.flatMap((run) => run.coverage.instances ?? []).find((one) => one.uri === uri && one.version === version
    && (one.maxDay === null || one.savedStart <= start && one.savedEnd >= (one.maxDay < end ? one.maxDay : end))) ?? null;
}
/** 호출자는 전체 인스턴스의 모든 날짜 저장이 성공한 뒤에만 기록한다. */
export async function recordInstanceCompletion(runId: string, completion: InstanceCompletion) {
  const run = await prisma.sourceCollectionRun.findUniqueOrThrow({ where: { id: runId }, select: { coverage: true } });
  const coverage = run.coverage as Prisma.InputJsonObject | null;
  const instances = (coverage?.instances ?? []) as unknown as InstanceCompletion[];
  await prisma.sourceCollectionRun.update({ where: { id: runId }, data: { coverage: { ...coverage,
    instances: [...instances.filter((one) => one.uri !== completion.uri), completion] as unknown as Prisma.InputJsonArray } } });
}
