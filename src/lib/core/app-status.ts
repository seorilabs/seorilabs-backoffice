import type { AppStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  HIDDEN_APP_ERROR,
  WRITABLE_APP_STATUSES,
  isDisabledAppStatus,
  isWritableAppStatus,
} from "@/lib/domain/app-visibility";

// 앱 운영 상태 변경(일시중지/운영). 서버액션·admin 엔드포인트 공용.
// DEPRECATED 는 DB 전용 비활성 플래그다. 앱에서 설정하거나 복구하지 않는다.

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
  if (isDisabledAppStatus(app.status)) {
    throw new Error(HIDDEN_APP_ERROR);
  }
  if (app.status === input.status) {
    return { id: app.id, slug: app.slug, status: app.status };
  }
  await prisma.app.update({
    where: { id: app.id },
    data: { status: input.status },
  });
  await prisma.auditLog.create({
    data: {
      actorLogin: input.actorLogin ?? null,
      action: "app.status",
      entityType: "App",
      entityId: app.id,
      payload: { from: app.status, to: input.status },
    },
  });
  return { id: app.id, slug: app.slug, status: input.status };
}
