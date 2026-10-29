import { env } from "@/lib/env";

/** 과거 리뷰의 승인된 원문 보존기한만 마친다. 새 Discord 게시와 명령은 제공하지 않는다. */
export async function deleteLegacyDiscordReview(destination: string, messageId: string, sender?: string): Promise<boolean> {
  const channelId = env.discordChannelId(destination);
  const token = sender === "seori" ? env.discordSeoriBotToken() || env.discordBotToken() : env.discordBotToken();
  if (!/^\d+$/.test(channelId) || !/^\d+$/.test(messageId) || !token) return false;
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,{method:"DELETE",headers:{Authorization:`Bot ${token}`},signal:AbortSignal.timeout(8000)});
    if (response.ok) return true;
    if (response.status === 404) { const data = await response.json() as {code?:number}; return data.code === 10008; }
    return false;
  } catch { return false; }
}
