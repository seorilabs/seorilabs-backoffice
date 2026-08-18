import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { handleDiscordInteraction } from "@/lib/discord/handler";
import { verifyDiscordSignature } from "@/lib/discord/security";
import type { DiscordInteraction } from "@/lib/discord/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.text();
  const valid = verifyDiscordSignature({
    body,
    signature: request.headers.get("x-signature-ed25519"),
    timestamp: request.headers.get("x-signature-timestamp"),
    publicKey: env.discordPublicKey(),
  });
  if (!valid) return NextResponse.json({ error: "invalid request signature" }, { status: 401 });

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    return NextResponse.json(await handleDiscordInteraction(interaction));
  } catch (error) {
    console.error("[discord/interactions] 실패", error instanceof Error ? error.message : "error");
    return NextResponse.json(ephemeralError());
  }
}

function ephemeralError() {
  return {
    type: 4,
    data: { content: "요청 처리 중 오류가 발생했습니다.", flags: 64, allowed_mentions: { parse: [] } },
  };
}
