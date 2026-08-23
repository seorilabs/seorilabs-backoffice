import { prisma } from "@/lib/prisma";
import { enqueueDeployCompletionNotification } from "@/lib/notifications/deploy-enqueue";
import { triggerXcodeCloudDeploy } from "@/lib/xcode-cloud/dispatch";

/**
 * Xcode Cloud build를 실행하고 GitHub workflow_run 대신 추적할 ReleaseRecord를 만든다.
 * stable 릴리스와 snapshot 후보가 같은 외부 실행 원장을 공유한다.
 */
export async function dispatchXcodeCloudRelease(opts: {
  repoFullName: string;
  tag: string;
  actorLabel?: string;
}): Promise<{ buildRunId: string; buildNumber: number | null }> {
  const app = await prisma.app.findUnique({
    where: { repoFullName: opts.repoFullName },
    select: { id: true, iosBundle: true },
  });
  if (!app?.iosBundle) {
    throw new Error(`iosBundle 미설정: ${opts.repoFullName} — Xcode Cloud 트리거 불가`);
  }

  const run = await triggerXcodeCloudDeploy({
    bundleId: app.iosBundle,
    repoFullName: opts.repoFullName,
    tag: opts.tag,
  });
  if (!run.buildRunId) throw new Error("Xcode Cloud 빌드 실행 ID가 없습니다.");

  const release = await prisma.releaseRecord.upsert({
    where: { externalRunId: run.buildRunId },
    create: {
      appId: app.id,
      version: opts.tag,
      market: "APPSTORE",
      track: "testflight-internal",
      status: "PENDING",
      workflowName: "Xcode Cloud",
      externalRunId: run.buildRunId,
      externalBuildNumber: run.buildNumber,
      triggeredBy: opts.actorLabel ?? null,
      startedAt: new Date(),
    },
    update: {
      version: opts.tag,
      track: "testflight-internal",
      status: "PENDING",
      externalBuildNumber: run.buildNumber,
      triggeredBy: opts.actorLabel ?? null,
    },
  });
  await enqueueDeployCompletionNotification({
    releaseRecordId: release.id,
    eventKey: `xcode:${run.buildRunId}:pending`,
    status: "PENDING",
  });
  return run;
}
