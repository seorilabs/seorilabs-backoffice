import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { verifyStaticToken } from "@/lib/security";
import { setWebhook, setMyCommands, setChatMenuButton } from "@/lib/telegram/client";
import { BOT_COMMANDS } from "@/lib/telegram/commands";

// Telegram webhook 을 코드로 등록(secret_token 바인딩). x-admin-token 보호.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const secret = env.telegramWebhookSecret();
  if (!env.telegramToken() || !secret) {
    return NextResponse.json({ error: "telegram not configured" }, { status: 400 });
  }
  const base = process.env.AUTH_URL || "https://backoffice.vzyx.xyz";
  const url = `${base.replace(/\/$/, "")}/api/telegram`;
  const result = await setWebhook(url, secret);
  // 명령어 메뉴 + 입력창 메뉴 버튼도 함께 등록.
  const commands = await setMyCommands(BOT_COMMANDS);
  const menuButton = await setChatMenuButton();
  return NextResponse.json({ url, result, commands, menuButton });
}
