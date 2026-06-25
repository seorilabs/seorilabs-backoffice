import { NextRequest, NextResponse } from "next/server";
import { verifyStaticToken } from "@/lib/security";
import { previewChat } from "@/lib/telegram/chat";

// 채팅 비서 일회성 미리보기(도구 루프 포함). 검증/디버그용. body { q }.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { q?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty */
  }
  const q = (body.q ?? "").trim();
  if (!q) return NextResponse.json({ error: "q 필요" }, { status: 400 });
  try {
    const reply = await previewChat(q);
    return NextResponse.json({ ok: true, reply });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
