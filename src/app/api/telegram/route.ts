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
  // 즉시 200 ack 후 백그라운드 처리.
  // AI 생성/tool-loop 가 Telegram webhook 타임아웃(~60s)을 넘겨 재시도·중복되는 것을 방지.
  // 롱리브드 Node 서버(standalone)라 응답 후에도 프라미스가 완료됨.
  void handleTelegramUpdate(update).catch((e) => {
    console.error("[telegram] handler error:", e instanceof Error ? e.message : e);
  });
  return NextResponse.json({ ok: true });
}
