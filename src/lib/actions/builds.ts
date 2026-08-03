"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth-helpers";
import {
  buildDispatchRequest,
  isBuildTarget,
  type BuildTarget,
} from "@/lib/core/build-targets";
import { HIDDEN_APP_ERROR, isDisabledAppStatus } from "@/lib/domain/app-visibility";
import {
  getAvailableBuildTargets,
  getRepoDefaultBranch,
  getWorkflowDispatchInputNames,
} from "@/lib/github/read";
import { dispatchWorkflow, resolveRefSha } from "@/lib/github/write";
import { prisma } from "@/lib/prisma";

const TAG_RE = /^v\d+\.\d+\.\d+$/;

async function appRepo(appId: string): Promise<string> {
  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: { repoFullName: true, status: true },
  });
  if (!app) throw new Error("앱을 찾을 수 없습니다.");
  if (isDisabledAppStatus(app.status)) throw new Error(HIDDEN_APP_ERROR);
  return app.repoFullName;
}

export async function dispatchBuildAction(
  appId: string,
  releaseTag: string,
  rawTarget: string,
): Promise<{ ok: boolean; workflowUrl?: string; error?: string }> {
  const session = await requireSession();
  if (!TAG_RE.test(releaseTag)) {
    return { ok: false, error: "잘못된 태그(vX.Y.Z)" };
  }
  if (!isBuildTarget(rawTarget)) {
    return { ok: false, error: "지원하지 않는 빌드 대상" };
  }

  try {
    const target: BuildTarget = rawTarget;
    const repoFullName = await appRepo(appId);
    const available = await getAvailableBuildTargets(repoFullName);
    if (!available.includes(target)) {
      return { ok: false, error: "기본 브랜치에 build-only workflow가 없습니다." };
    }

    const defaultBranch = await getRepoDefaultBranch(repoFullName);
    const { workflowFile, inputs } = buildDispatchRequest(target, releaseTag);
    const declaredInputs = await getWorkflowDispatchInputNames(
      repoFullName,
      workflowFile,
      defaultBranch,
    );
    if (!declaredInputs.has("release_tag")) {
      return { ok: false, error: `${workflowFile}에 release_tag 입력이 없습니다.` };
    }

    await resolveRefSha(repoFullName, releaseTag);
    await dispatchWorkflow({
      repoFullName,
      workflowFile,
      ref: defaultBranch,
      inputs,
    });

    await prisma.auditLog
      .create({
        data: {
          actorLogin: `web:${session.user.login ?? "?"}`,
          action: "build.workflow.dispatch",
          entityType: "app",
          entityId: appId,
          payload: {
            repoFullName,
            target,
            releaseTag,
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
