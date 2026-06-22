import { NextResponse } from "next/server";
import { register, collectDefaultMetrics } from "prom-client";

// Prometheus 스크레이프용. ServiceMonitor 가 /metrics 로 수집.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let inited = false;
function init() {
  if (inited) return;
  collectDefaultMetrics({ prefix: "backoffice_" });
  inited = true;
}

export async function GET() {
  init();
  const body = await register.metrics();
  return new NextResponse(body, {
    headers: { "content-type": register.contentType },
  });
}
