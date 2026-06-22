import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// readiness: DB 연결 확인. ingress 미노출(클러스터 내부 probe 전용).
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ready" });
  } catch {
    return NextResponse.json({ status: "not-ready" }, { status: 503 });
  }
}
