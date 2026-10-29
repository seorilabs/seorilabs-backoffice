import type { DeliveryOverrideResult } from "@/lib/notifications/outbox";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { editNotification, sendNotification } from "@/lib/notifications/channel";
import type { MessageOptions } from "@/lib/notifications/channel";
import { approvalCard } from "./cards";
import { remindersAllowed } from "./policy";
const defaults = { prisma, editNotification, sendNotification };
export async function deliverApproval(payload: Prisma.JsonObject, destinationKey: string, messageId: string | null, dependencies = defaults, now = new Date(), deliveryOptions: MessageOptions = {}): Promise<DeliveryOverrideResult> {
  const { prisma, editNotification, sendNotification } = dependencies;
  const row = await prisma.deploymentApproval.findUnique({ where: { id: String(payload.deploymentApprovalId) } });
  if (!row) return { ok: false, error: "승인 기록 없음", terminal: true };
  if (payload.reminder === true && !messageId) {
    if (row.providerState !== "WAITING" || row.actionState !== "IDLE") return { ok: true };
    if (!remindersAllowed(now)) {
      const nextMorning = new Date(now); nextMorning.setUTCHours(24, 0, 0, 0);
      return { ok: false, error: "야간 재알림 보류", retryAfterMs: nextMorning.getTime() - now.getTime() };
    }
  }
  const card = approvalCard(row);
  const options = { ...deliveryOptions, components: card.components, alertRoleId: row.providerState === "WAITING" ? env.operatorRoleMention("release_ops") : undefined };
  let result = messageId ? await editNotification(destinationKey, messageId, card.text, options) : null;
  // 삭제된 카드만 새 메시지로 대체한다. timeout/권한 오류에 중복 카드를 만들지 않는다.
  if (!result || (!result.ok && result.error === "message_not_found")) result = await sendNotification(destinationKey, card.text, options);
  if (result.ok && payload.reminder !== true) await prisma.deploymentApproval.updateMany({ where: { id: row.id, initialNotifiedAt: null }, data: { initialNotifiedAt: now } });
  if (result.ok && payload.reminder === true && !messageId) await prisma.deploymentApproval.updateMany({ where: { id: row.id, providerState: "WAITING" }, data: { nextReminderAt: new Date(now.getTime() + 120 * 60_000) } });
  return result;
}
