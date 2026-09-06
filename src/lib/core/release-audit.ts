import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function recordReleaseAudit(
  opts: { repoFullName: string; tag: string; actorLabel?: string },
  action: string,
  payload: Prisma.InputJsonObject,
  write: (data: Prisma.AuditLogCreateInput) => Promise<unknown> =
    (data) => prisma.auditLog.create({ data }),
): Promise<void> {
  await write({
        actorLogin: opts.actorLabel ?? null,
        action,
        entityType: "release",
        entityId: `${opts.repoFullName}@${opts.tag}`,
        payload,
    })
    .catch(() => {
      // 외부 동작을 재실행하지 않도록 결과는 보존하고 감사 누락만 공개 action으로 알린다.
      console.error("[release-ops] 감사 기록 저장 실패", { action });
    });
}
