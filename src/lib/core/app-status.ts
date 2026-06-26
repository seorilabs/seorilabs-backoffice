import type { AppStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// 앱 운영 상태 변경(존치/일시중지/운영). 서버액션·admin 엔드포인트 공용.
// DEPRECATED("존치") = 더 이상 업데이트 안 하지만 배포는 유지 — LiveOps 넛지/리뷰에서 제외.

export const APP_STATUSES: AppStatus[] = ["ACTIVE", "PAUSED", "DEPRECATED"];

export function isAppStatus(s: string): s is AppStatus {
  return (APP_STATUSES as string[]).includes(s);
}

export async function setAppStatusCore(input: {
  idOrSlug: string;
  status: AppStatus;
  actorLogin?: string | null;
}): Promise<{ id: string; slug: string; status: AppStatus } | null> {
  const app = await prisma.app.findFirst({
    where: { OR: [{ id: input.idOrSlug }, { slug: input.idOrSlug }] },
    select: { id: true, slug: true, status: true },
  });
  if (!app) return null;
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
