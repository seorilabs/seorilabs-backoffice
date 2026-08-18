"use server";

import { revalidatePath } from "next/cache";
import type { Lifecycle, AppStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordTransition } from "@/lib/sync/transition";
import { requireSession } from "@/lib/auth-helpers";
import { notifyStageNudge } from "@/lib/notifications/proactive";
import { setAppStatusCore } from "@/lib/core/app-status";
import { HIDDEN_APP_ERROR, visibleAppWhere } from "@/lib/domain/app-visibility";

// 보드에서 수동 라이프사이클 전이.
export async function transitionApp(
  appId: string,
  to: Lifecycle,
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const login = session.user.login ?? null;
  const app = await prisma.app.findFirst({
    where: { id: appId, ...visibleAppWhere },
    select: { id: true },
  });
  if (!app) throw new Error(HIDDEN_APP_ERROR);

  const changed = await recordTransition({
    appId,
    to,
    source: "BACKOFFICE",
    actorLogin: login,
    reason: "수동 전이(보드)",
    signalRef: "manual",
  });

  if (changed) {
    await prisma.auditLog.create({
      data: {
        actorLogin: login,
        action: "stage.transition",
        entityType: "App",
        entityId: appId,
        payload: { to },
      },
    });
    // 다음 단계 에이전트 제안(넛지). 응답 블로킹 안 하도록 fire-and-forget.
    void notifyStageNudge(appId, to);
  }

  revalidatePath("/board");
  revalidatePath("/");
  revalidatePath(`/apps/${appId}`);
  return { ok: changed };
}

// 앱 운영 상태 변경(일시중지/운영 재개). 비활성 복구는 DB 직접 변경만 허용.
export async function setAppStatus(
  appId: string,
  status: AppStatus,
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const r = await setAppStatusCore({
    idOrSlug: appId,
    status,
    actorLogin: session.user.login ?? null,
  });
  revalidatePath("/");
  revalidatePath("/board");
  revalidatePath("/releases");
  revalidatePath(`/apps/${appId}`);
  return { ok: Boolean(r) };
}
