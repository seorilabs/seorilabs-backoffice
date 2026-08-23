import { prisma } from "@/lib/prisma";
import { enqueueDeployCompletionNotification } from "@/lib/notifications/deploy-enqueue";
import { triggerXcodeCloudDeploy } from "@/lib/xcode-cloud/dispatch";

interface XcodeCloudReleaseApp {
  id: string;
  repoFullName: string;
  iosBundle: string | null;
}

export function resolveXcodeCloudReleaseBinding(input: {
  app: XcodeCloudReleaseApp | null;
  repoFullName: string;
  expectedAppId?: string;
  expectedIosBundle?: string;
}): { appId: string; iosBundle: string } {
  if (!input.app) {
    throw new Error(`앱을 찾을 수 없음: ${input.repoFullName} — Xcode Cloud 트리거 불가`);
  }
  if (
    input.expectedAppId !== undefined &&
    input.app.id !== input.expectedAppId
  ) {
    throw new Error("확인 후 앱 ID가 변경됐습니다. 다시 요청해 확인하세요.");
  }
  if (input.app.repoFullName !== input.repoFullName) {
    throw new Error("확인 후 앱 저장소가 변경됐습니다. 다시 요청해 확인하세요.");
  }
  if (!input.app.iosBundle) {
    throw new Error(`iosBundle 미설정: ${input.repoFullName} — Xcode Cloud 트리거 불가`);
  }
  if (
    input.expectedIosBundle !== undefined &&
    input.app.iosBundle !== input.expectedIosBundle
  ) {
    throw new Error("확인 후 iOS bundle ID가 변경됐습니다. 다시 요청해 확인하세요.");
  }
  return {
    appId: input.app.id,
    iosBundle: input.expectedIosBundle ?? input.app.iosBundle,
  };
}

/**
 * Xcode Cloud build를 실행하고 GitHub workflow_run 대신 추적할 ReleaseRecord를 만든다.
 * stable 릴리스와 snapshot 후보가 같은 외부 실행 원장을 공유한다.
 */
export async function dispatchXcodeCloudRelease(opts: {
  repoFullName: string;
  tag: string;
  actorLabel?: string;
  expectedAppId?: string;
  expectedIosBundle?: string;
}): Promise<{ buildRunId: string; buildNumber: number | null }> {
  const app = await prisma.app.findUnique({
    where:
      opts.expectedAppId !== undefined
        ? { id: opts.expectedAppId }
        : { repoFullName: opts.repoFullName },
    select: { id: true, repoFullName: true, iosBundle: true },
  });
  const binding = resolveXcodeCloudReleaseBinding({
    app,
    repoFullName: opts.repoFullName,
    expectedAppId: opts.expectedAppId,
    expectedIosBundle: opts.expectedIosBundle,
  });

  const run = await triggerXcodeCloudDeploy({
    bundleId: binding.iosBundle,
    repoFullName: opts.repoFullName,
    tag: opts.tag,
  });
  if (!run.buildRunId) throw new Error("Xcode Cloud 빌드 실행 ID가 없습니다.");

  const release = await prisma.releaseRecord.upsert({
    where: { externalRunId: run.buildRunId },
    create: {
      appId: binding.appId,
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
