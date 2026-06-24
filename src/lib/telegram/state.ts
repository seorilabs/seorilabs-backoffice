import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

// 텔레그램 다단계 흐름 상태(chatId당 1건). 예: /plan 앱 선택 후 아이디어 입력 대기.

export async function setPending(
  chatId: string | number,
  action: string,
  data: Prisma.InputJsonObject,
): Promise<void> {
  const cid = String(chatId);
  await prisma.telegramPending.upsert({
    where: { chatId: cid },
    create: { chatId: cid, action, dataJson: data },
    update: { action, dataJson: data },
  });
}

export async function getPending(
  chatId: string | number,
): Promise<{ action: string; data: Record<string, unknown> } | null> {
  const row = await prisma.telegramPending.findUnique({
    where: { chatId: String(chatId) },
  });
  if (!row) return null;
  return {
    action: row.action,
    data: (row.dataJson as Record<string, unknown>) ?? {},
  };
}

export async function clearPending(chatId: string | number): Promise<void> {
  await prisma.telegramPending.deleteMany({ where: { chatId: String(chatId) } });
}
