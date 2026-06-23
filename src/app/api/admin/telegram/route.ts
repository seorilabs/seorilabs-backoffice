import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { verifyStaticToken } from "@/lib/security";
import { setWebhook } from "@/lib/telegram/client";

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
  return NextResponse.json({ url, result });
}
