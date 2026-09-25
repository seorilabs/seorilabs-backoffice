import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { verifyAppleWebhookSignature } from "@/lib/app-store/webhook-verify";
import { extractAppleSubmissionEvent } from "@/lib/app-store/submission-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = env.optional("APP_STORE_WEBHOOK_SECRET").trim();
  if (!secret) return NextResponse.json({ ok: false }, { status: 503 });
  const body = await req.text();
  if (!verifyAppleWebhookSignature({
    body, signature: req.headers.get("x-apple-signature"), secret,
  })) return NextResponse.json({ ok: false }, { status: 401 });
  let payload: unknown;
  try { payload = JSON.parse(body); } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const event = extractAppleSubmissionEvent(payload);
  if (!event) return NextResponse.json({ ok: true, ignored: true });
  try {
    await prisma.storeSubmissionWebhookEvent.upsert({
      where: { id: event.externalEventId },
      create: { id: event.externalEventId, payload: payload as object },
      update: {},
    });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
