import { lockAppForNewWork } from "@/lib/control-plane/app-work-lock";
import type { AppStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  HIDDEN_APP_ERROR,
  WRITABLE_APP_STATUSES,
  isWritableAppStatus,
} from "@/lib/domain/app-visibility";

// 앱 운영 상태 변경(일시중지/운영). 서버액션·admin 엔드포인트 공용.
// 숨김·복구는 중앙 상태 서비스가 맡으며 일반 중지/재개가 이를 덮어쓰지 않는다.

export const APP_STATUSES: AppStatus[] = [...WRITABLE_APP_STATUSES];

export function isAppStatus(s: string): s is (typeof WRITABLE_APP_STATUSES)[number] {
  return isWritableAppStatus(s);
}

export async function setAppStatusCore(input: {
  idOrSlug: string;
  status: AppStatus;
  actorLogin?: string | null;
}): Promise<{ id: string; slug: string; status: AppStatus } | null> {
  if (!isWritableAppStatus(input.status)) {
    throw new Error(HIDDEN_APP_ERROR);
  }
  const app = await prisma.app.findFirst({
    where: { OR: [{ id: input.idOrSlug }, { slug: input.idOrSlug }] },
    select: { id: true, slug: true, status: true },
  });
  if (!app) return null;
  return prisma.$transaction(async (tx) => {
    const current = await lockAppForNewWork(tx, app.id);
    if (current.status === input.status) {
      return {id: app.id, slug: app.slug, status: current.status};
    }
    await tx.app.update({where: {id: app.id}, data: {status: input.status}});
    await tx.auditLog.create({
      data: {
        actorLogin: input.actorLogin ?? null,
        action: "app.status",
        entityType: "App",
        entityId: app.id,
        payload: {from: current.status, to: input.status},
      },
    });
    return {id: app.id, slug: app.slug, status: input.status};
  });
}
