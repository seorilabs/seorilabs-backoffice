import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { verifyGrafanaSignature } from "@/lib/discord/security";
import { ingestGrafanaWebhook } from "@/lib/notifications/grafana";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.text();
  if (!verifyGrafanaSignature({
    body,
    signature: request.headers.get("x-grafana-alerting-signature"),
    timestamp: request.headers.get("x-grafana-alerting-timestamp"),
    secret: env.grafanaAlertHmacSecret(),
  })) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await ingestGrafanaWebhook(parsed)) }, { status: 202 });
  } catch (error) {
    console.error("[grafana/alerts] 잘못된 payload", error instanceof Error ? error.message : "error");
    return NextResponse.json({ error: "invalid alert payload" }, { status: 400 });
  }
}
