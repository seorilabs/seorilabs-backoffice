import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { verifyStaticToken } from "@/lib/security";
import { standupDedupeKey } from "@/lib/discord/teammate-standup";

// 아침 스탠드업 트리거(CronJob 이 호출). 여기서는 teammate_run PENDING 행만 넣고
// teammate worker 가 소화한다. dedupeKey(KST 날짜) unique 라 중복 발화는 무해하다.
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
  try {
    const run = await prisma.teammateRun.create({
      data: {
        teammate: "standup",
        trigger: "standup",
        dedupeKey: standupDedupeKey(),
        scope: "standup",
      },
      select: { id: true },
    });
    return NextResponse.json({ ok: true, runId: run.id }, { status: 202 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ ok: true, alreadyEnqueued: true });
    }
    console.error("[admin/teammates/standup] 실패:", error);
    return NextResponse.json({ error: "enqueue failed" }, { status: 500 });
  }
}
