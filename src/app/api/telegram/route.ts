import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { verifyStaticToken } from "@/lib/security";
import { handleTelegramUpdate, type TgUpdate } from "@/lib/telegram/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Telegram setWebhook 의 secret_token → X-Telegram-Bot-Api-Secret-Token 헤더로 회수(상수시간, 길이 비의존).
function verifySecret(header: string | null): boolean {
  return verifyStaticToken(header, env.telegramWebhookSecret() || undefined);
}

export async function POST(req: NextRequest) {
  if (!env.telegramEnabled()) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  if (!verifySecret(req.headers.get("x-telegram-bot-api-secret-token"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  try {
    await handleTelegramUpdate(update);
  } catch (e) {
    console.error("[telegram] handler error:", e);
  }
  return NextResponse.json({ ok: true });
}
