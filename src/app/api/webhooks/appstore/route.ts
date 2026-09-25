import { after, NextResponse, type NextRequest } from "next/server";

import {
  DEFAULT_WEBHOOK_AUDIENCE,
  verifyAppleWebhookToken,
} from "@/lib/app-store/webhook-verify";
import { extractAppleSubmissionEvent } from "@/lib/app-store/submission-events";
import { receiveAppStoreSubmissionEvent } from "@/lib/app-store/submission-receiver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AppleJwsPayload {
  iss?: string;
  payload?: unknown;
  signedPayload?: unknown;
}

function extractPayloadFromVerified(
  verified: { raw: unknown } | { payload: unknown },
): unknown {
  if (
    verified &&
    typeof verified === "object" &&
    "raw" in verified &&
    verified.raw
  ) {
    return verified.raw;
  }
  if (verified && typeof verified === "object" && "payload" in verified) {
    return verified.payload;
  }
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let token: string;
  try {
    const headerToken = req.headers.get("x-apple-signature") ?? req.headers.get("X-Apple-Signature");
    if (headerToken && headerToken.length > 0) {
      token = headerToken;
    } else {
      token = await req.text();
    }
  } catch {
    return NextResponse.json(
      { ok: false, error: "signature required" },
      { status: 401 },
    );
  }
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "signature required" },
      { status: 401 },
    );
  }

  let verified: Awaited<ReturnType<typeof verifyAppleWebhookToken>>;
  try {
    verified = await verifyAppleWebhookToken({
      token,
      expectedAudience: DEFAULT_WEBHOOK_AUDIENCE,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "signature invalid" },
      { status: 401 },
    );
  }

  const decoded = verified.raw as AppleJwsPayload | undefined;
  const eventPayload =
    decoded?.payload ?? decoded?.signedPayload ?? extractPayloadFromVerified(verified);

  const event = extractAppleSubmissionEvent(eventPayload);
  if (!event) {
    return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
  }

  after(async () => {
    try {
      await receiveAppStoreSubmissionEvent(event);
    } catch {
      // webhook 은 200 을 유지하고 별도 텔레메트리로 표면화.
    }
  });

  return NextResponse.json({ ok: true, eventId: event.externalEventId }, { status: 200 });
}
