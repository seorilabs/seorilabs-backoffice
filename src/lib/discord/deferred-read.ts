import { InteractionType, type DiscordInteraction } from "./types";
export const DEFERRED_READ_COMMANDS = [
  "approvals",
  "p1",
  "status",
  "metrics",
  "report",
  "reviews",
  "keywords",
  "health",
  "insights",
] as const;
export function shouldDeferRead(interaction: DiscordInteraction) {
  return (
    interaction.type === InteractionType.APPLICATION_COMMAND &&
    !!interaction.token &&
    DEFERRED_READ_COMMANDS.some((name) => name === interaction.data?.name)
  );
}
export async function completeDeferredRead(
  interaction: DiscordInteraction,
  handle: (value: DiscordInteraction) => Promise<{ type?: number; data?: unknown }>,
  request: typeof fetch = fetch,
) {
  const started = Date.now();
  let data: unknown;
  try {
    data = (await handle(interaction)).data ?? { content: "조회 결과를 확인할 수 없습니다." };
  } catch {
    data = { content: "조회에 실패했습니다. 수집 상태를 확인하세요." };
  }
  if (Date.now() - started >= 14 * 60_000) return;
  const response = await request(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${encodeURIComponent(interaction.token!)}/messages/@original`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(data as Record<string, unknown>),
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`DISCORD_DEFERRED_RESPONSE_HTTP_${response.status}`);
}
