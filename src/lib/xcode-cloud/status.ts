import { prisma } from "@/lib/prisma";
import { asc, asArray } from "@/lib/app-store/asc-client";
import { evaluateLifecycleOnSuccessfulRelease } from "@/lib/sync/mirror";
import { enqueueDeployCompletionNotification } from "@/lib/notifications/deploy-enqueue";
import { shouldAdvanceLifecycleForRelease } from "@/lib/sync/release-status";
import { syncXcodeCloudRow } from "@/lib/xcode-cloud/sync-row";
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
  failed: number;
  state: "completed" | "busy" | "partial";
  ok: boolean;
}> {
  if (syncing) {
    return {
      checked: 0,
      completed: 0,
      failed: 0,
      state: "busy",
      ok: false,
    };
  }
  syncing = true;
  try {
    const pending = await prisma.releaseRecord.findMany({
      where: {
        externalRunId: { not: null },
        status: { in: ["PENDING", "IN_PROGRESS"] },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: {
        id: true,
        externalRunId: true,
        status: true,
      },
    });
    let completed = 0;
    let failed = 0;
    for (const row of pending) {
      if (!row.externalRunId) continue;
      const syncRow = { ...row, externalRunId: row.externalRunId };
      try {
        const synced = await syncXcodeCloudRow(syncRow, {
          readStatus: readXcodeCloudBuildStatus,
          persistStatus: async ({ result, terminal, statusChanged }) => {
            await prisma.$transaction(async (tx) => {
              if (statusChanged) {
                await enqueueDeployCompletionNotification({
                  releaseRecordId: row.id,
                  eventKey: terminal
                    ? `xcode:${row.externalRunId}`
                    : `xcode:${row.externalRunId}:${result.status.toLowerCase()}`,
                  status: result.status,
                }, tx);
              }
              await tx.releaseRecord.update({
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
            });
          },
        });
        if (synced.terminal) completed++;
      } catch (error) {
        failed++;
        console.error(
          `[xcode-cloud] 상태 조회 실패 ${row.externalRunId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // terminal status는 pending 조회에서 제외된다. lifecycle 전이가 일시 실패해도
    // 다음 주기에 다시 선택되도록 stage와 성공 release를 별도 내구성 큐로 사용한다.
    const lifecycleApps = await prisma.app.findMany({
      where: { currentStage: { in: ["MARKET_SUBMISSION", "RELEASE"] } },
      select: {
        id: true,
        releases: {
          where: { externalRunId: { not: null }, status: "SUCCEEDED" },
          orderBy: { updatedAt: "desc" },
          select: { externalRunId: true, version: true },
        },
      },
    });
    for (const app of lifecycleApps) {
      const release = app.releases.find((candidate) =>
        shouldAdvanceLifecycleForRelease("SUCCEEDED", candidate.version),
      );
      if (!release?.externalRunId) continue;
      try {
        await evaluateLifecycleOnSuccessfulRelease(
          app.id,
          `xcode_cloud:${release.externalRunId}`,
        );
      } catch (error) {
        failed++;
        console.error(
          `[xcode-cloud] lifecycle 전이 실패 ${release.externalRunId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return {
      checked: pending.length,
      completed,
      failed,
      state: failed === 0 ? "completed" : "partial",
      ok: failed === 0,
    };
  } finally {
    syncing = false;
  }
}
