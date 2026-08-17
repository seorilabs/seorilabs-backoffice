import { prisma } from "@/lib/prisma";
import { asc, asArray } from "@/lib/app-store/asc-client";
import { evaluateLifecycleOnSuccessfulRelease } from "@/lib/sync/mirror";
import { enqueueDeployCompletionNotification } from "@/lib/telegram/deploy-notifications";
import {
  mapXcodeCloudBuildStatus,
  type XcodeCloudBuildStatus,
} from "@/lib/xcode-cloud/status-shape";

export async function readXcodeCloudBuildStatus(
  buildRunId: string,
): Promise<XcodeCloudBuildStatus> {
  const doc = await asc(`/v1/ciBuildRuns/${encodeURIComponent(buildRunId)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const run = asArray(doc.data)[0];
  if (!run) throw new Error(`Xcode Cloud 빌드 실행을 찾을 수 없습니다: ${buildRunId}`);
  return mapXcodeCloudBuildStatus(run.attributes);
}

let syncing = false;

export async function syncPendingXcodeCloudDeployments(limit = 30): Promise<{
  checked: number;
  completed: number;
}> {
  if (syncing) return { checked: 0, completed: 0 };
  syncing = true;
  try {
    const pending = await prisma.releaseRecord.findMany({
      where: {
        externalRunId: { not: null },
        status: { in: ["PENDING", "IN_PROGRESS"] },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true, appId: true, externalRunId: true, status: true },
    });
    let completed = 0;
    for (const row of pending) {
      if (!row.externalRunId) continue;
      try {
        const result = await readXcodeCloudBuildStatus(row.externalRunId);
        const terminal = result.status === "SUCCEEDED" || result.status === "FAILED";
        await prisma.releaseRecord.update({
          where: { id: row.id },
          data: {
            status: result.status,
            externalBuildNumber: result.buildNumber,
            startedAt: result.startedAt ?? undefined,
            deployedAt:
              result.status === "SUCCEEDED"
                ? result.finishedAt ?? new Date()
                : null,
          },
        });
        if (row.status !== result.status) {
          await enqueueDeployCompletionNotification({
            releaseRecordId: row.id,
            eventKey: terminal
              ? `xcode:${row.externalRunId}`
              : `xcode:${row.externalRunId}:${result.status.toLowerCase()}`,
            status: result.status,
          });
        }
        if (!terminal) continue;
        completed++;
        if (result.status === "SUCCEEDED") {
          await evaluateLifecycleOnSuccessfulRelease(
            row.appId,
            `xcode_cloud:${row.externalRunId}`,
          );
        }
      } catch (error) {
        console.error(
          `[xcode-cloud] 상태 조회 실패 ${row.externalRunId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return { checked: pending.length, completed };
  } finally {
    syncing = false;
  }
}
