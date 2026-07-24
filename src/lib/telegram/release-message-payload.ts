import type { DeployTarget } from "@/lib/core/deploy-targets";

const DEPLOY_TARGETS = new Set<DeployTarget>(["AIT", "PLAY", "APPSTORE", "ALL"]);

export function deployTargetFromAuditPayload(payload: unknown): DeployTarget | null {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const target = String((payload as { target?: unknown }).target ?? "") as DeployTarget;
  return DEPLOY_TARGETS.has(target) ? target : null;
}

export function telegramContextFromAuditPayload(
  payload: unknown,
): { chatId: string; messageId: number } | null {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const telegram = (payload as { telegram?: unknown }).telegram;
  if (telegram == null || typeof telegram !== "object" || Array.isArray(telegram)) return null;
  const chatId = String((telegram as { chatId?: unknown }).chatId ?? "");
  const messageId = Number((telegram as { messageId?: unknown }).messageId);
  if (!/^-?\d+$/.test(chatId) || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
  return { chatId, messageId };
}
