import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { verifyStaticToken } from "@/lib/security";
import { isTeammateRole } from "@/lib/discord/teammates";
import { patrolDedupeKey } from "@/lib/discord/teammate-findings";

// AI 팀원 순찰 트리거(CronJob 이 role 별로 호출). 순찰 자체는 수 분이 걸릴 수
// 있어 여기서는 teammate_run PENDING 행만 넣고 teammate worker 가 소화한다.
// dedupeKey(role×KST 날짜) unique 라 CronJob 중복 발화는 무해하다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  if (!verifyStaticToken(req.headers.get("x-admin-token"), process.env.INTERNAL_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!env.featureDiscordTeammates()) {
    return NextResponse.json({ error: "teammates disabled" }, { status: 503 });
  }
  const role = req.nextUrl.searchParams.get("role") ?? "";
  if (!isTeammateRole(role)) {
    return NextResponse.json({ error: "unknown role" }, { status: 400 });
  }
  try {
    const run = await prisma.teammateRun.create({
      data: {
        teammate: role,
        trigger: "schedule",
        dedupeKey: patrolDedupeKey(role),
        scope: `patrol:${role}`,
      },
      select: { id: true },
    });
    return NextResponse.json({ ok: true, runId: run.id }, { status: 202 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ ok: true, alreadyEnqueued: true });
    }
    console.error("[admin/teammates/patrol] 실패:", error);
    return NextResponse.json({ error: "enqueue failed" }, { status: 500 });
  }
}
