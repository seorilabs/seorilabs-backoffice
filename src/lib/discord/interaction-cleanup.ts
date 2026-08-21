import { InteractionResponseType, InteractionType, type DiscordInteraction } from "@/lib/discord/types";

const API_BASE = "https://discord.com/api/v10";

type InteractionResponse = { type?: number };

export function shouldDeleteEphemeralConfirmation(
  interaction: DiscordInteraction,
  response: InteractionResponse,
): boolean {
  if (interaction.type !== InteractionType.MESSAGE_COMPONENT) return false;
  if (response.type !== InteractionResponseType.DEFERRED_UPDATE_MESSAGE) return false;
  const customId = interaction.data?.custom_id ?? "";
  return customId.startsWith("command:econfirm:") || customId.startsWith("command:ecancel:");
}

export async function deleteOriginalInteractionResponse(
  input: { applicationId: string; interactionToken: string },
  request: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^\d+$/.test(input.applicationId) || !input.interactionToken) {
    return { ok: false, error: "Discord application/interaction token 오류" };
  }
  try {
    const response = await request(
      `${API_BASE}/webhooks/${input.applicationId}/${encodeURIComponent(input.interactionToken)}/messages/@original`,
      { method: "DELETE", signal: AbortSignal.timeout(10_000) },
    );
    return response.ok
      ? { ok: true }
      : { ok: false, error: `Discord HTTP ${response.status}` };
  } catch {
    // interaction token 이 포함될 수 있는 네트워크 예외 원문은 로그에 남기지 않는다.
    return { ok: false, error: "Discord interaction cleanup network error" };
  }
}
