"use server";

import { revalidatePath } from "next/cache";

import { requireReleaseWriteAccess } from "@/lib/core/release-access";
import {
  buildDispatchRequest,
  isBuildTarget,
  type BuildTarget,
} from "@/lib/core/build-targets";
import { resolveStableTagSha } from "@/lib/github/release";
import {
  getWorkflowDispatchInputNames,
} from "@/lib/github/read";
import { dispatchWorkflow } from "@/lib/github/write";
import { prisma } from "@/lib/prisma";

const TAG_RE = /^v\d+\.\d+\.\d+$/;

export async function dispatchBuildAction(
  appId: string,
  releaseTag: string,
  rawTarget: string,
): Promise<{ ok: boolean; workflowUrl?: string; error?: string }> {
  if (!TAG_RE.test(releaseTag)) {
    return { ok: false, error: "잘못된 태그(vX.Y.Z)" };
  }
  if (!isBuildTarget(rawTarget)) {
    return { ok: false, error: "지원하지 않는 빌드 대상" };
  }

  try {
    const target: BuildTarget = rawTarget;
    const actor = await requireReleaseWriteAccess(appId);
    const repoFullName = actor.repoFullName;
    const { workflowFile, inputs } = buildDispatchRequest(target, releaseTag);
    const releaseSha = await resolveStableTagSha(repoFullName, releaseTag);
    const declaredInputs = await getWorkflowDispatchInputNames(
      repoFullName,
      workflowFile,
      releaseSha,
    );
    if (!declaredInputs.has("release_tag")) {
      return { ok: false, error: `${workflowFile}에 release_tag 입력이 없습니다.` };
    }

    await dispatchWorkflow({
      repoFullName,
      workflowFile,
      ref: releaseTag,
      inputs,
      expectedTag: { tag: releaseTag, sha: releaseSha },
    });

    await prisma.auditLog
      .create({
        data: {
          actorLogin: `web:${actor.login}`,
          action: "build.workflow.dispatch",
          entityType: "app",
          entityId: appId,
          payload: {
            repoFullName,
            target,
            releaseTag,
            sha: releaseSha,
            workflowFile,
            upload: false,
          } as object,
        },
      })
      .catch(() => {});

    revalidatePath(`/apps/${appId}/releases`);
    return {
      ok: true,
      workflowUrl: `https://github.com/${repoFullName}/actions/workflows/${workflowFile}`,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
