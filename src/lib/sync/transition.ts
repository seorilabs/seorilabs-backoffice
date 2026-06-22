import { prisma } from "@/lib/prisma";
import type { Lifecycle, TransitionSource } from "@prisma/client";

// DB 라이프사이클 전이 기록 (App.currentStage 갱신 + StageTransition append).
// GitHub stage:* 라벨 역기록은 server action(수동 전이) 경로에서 별도 수행한다.
export async function recordTransition(opts: {
  appId: string;
  to: Lifecycle;
  source: TransitionSource;
  actorLogin?: string | null;
  reason?: string | null;
  signalRef?: string | null;
}): Promise<boolean> {
  const app = await prisma.app.findUnique({
    where: { id: opts.appId },
    select: { currentStage: true },
  });
  if (!app || app.currentStage === opts.to) return false;

  await prisma.$transaction([
    prisma.app.update({
      where: { id: opts.appId },
      data: { currentStage: opts.to },
    }),
    prisma.stageTransition.create({
      data: {
        appId: opts.appId,
        fromStage: app.currentStage,
        toStage: opts.to,
        source: opts.source,
        actorLogin: opts.actorLogin ?? null,
        reason: opts.reason ?? null,
        signalRef: opts.signalRef ?? null,
      },
    }),
  ]);
  return true;
}
