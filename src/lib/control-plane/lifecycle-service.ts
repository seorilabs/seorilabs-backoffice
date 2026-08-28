import { Prisma } from "@prisma/client";

import {
  humanLifecycleTransitionDecision,
  type HumanTransitionStage,
} from "@/lib/control-plane/lifecycle-policy";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

/**
 * IDEA~RELEASE_ASSETS 구간에는 자동 관측 증거가 없다.
 * 이 경로는 신뢰된 로컬 사람 UI의 server action 전용이며 bearer API 경로를 열지 않는다.
 * 낙관적 동시성(generation CAS), RBAC(호출부), idempotency, append-only 원장을 모두 유지한다.
 */
export async function advanceFleetLifecycleStageFromHumanUi(input: {
  repoId: bigint;
  toStage: HumanTransitionStage;
  expectedGeneration: number;
  actor: string;
  idempotencyKey: string;
}) {
  const replay = await prisma.fleetLifecycleEvent.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    if (replay.toStage !== input.toStage || replay.app.repoId !== input.repoId || replay.actor !== input.actor) {
      throw new ControlPlaneError(
        "idempotency key가 다른 lifecycle 전이에 사용되었습니다.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    const current = await prisma.fleetLifecycleState.findUnique({ where: { appId: replay.appId } });
    return { state: current, event: replay, duplicate: true };
  }

  return prisma.$transaction(async (tx) => {
    const app = await tx.app.findUnique({
      where: { repoId: input.repoId },
      select: { id: true },
    });
    if (!app) throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
    const existing = await tx.fleetLifecycleState.findUnique({ where: { appId: app.id } });
    const fromStage = existing?.stage ?? "IDEA";
    const currentGeneration = existing?.generation ?? 0;
    const decision = humanLifecycleTransitionDecision({ from: fromStage, to: input.toStage });
    if (!decision.ok) throw new ControlPlaneError(decision.message, 409, decision.code);
    if (currentGeneration !== input.expectedGeneration) {
      throw new ControlPlaneError(
        "lifecycle generation이 이미 변경되었습니다. 최신 상태를 다시 읽어야 합니다.",
        409,
        "LIFECYCLE_STATE_CONFLICT",
      );
    }

    if (existing) {
      const updated = await tx.fleetLifecycleState.updateMany({
        where: { appId: app.id, stage: fromStage, generation: input.expectedGeneration },
        data: { stage: input.toStage, generation: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new ControlPlaneError(
          "lifecycle 상태가 동시에 변경되어 전이를 적용하지 못했습니다.",
          409,
          "LIFECYCLE_STATE_CONFLICT",
        );
      }
    } else {
      await tx.fleetLifecycleState.create({
        data: { appId: app.id, stage: input.toStage, generation: 1 },
      });
    }

    const event = await tx.fleetLifecycleEvent.create({
      data: {
        appId: app.id,
        fromStage,
        toStage: input.toStage,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        evidence: { transitionSource: "BACKOFFICE_HUMAN_UI", expectedGeneration: input.expectedGeneration },
      },
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.fleet-lifecycle.advance.human-ui",
        entityType: "FleetLifecycleState",
        entityId: app.id,
        payload: {
          appId: app.id,
          fromStage,
          toStage: input.toStage,
          expectedGeneration: input.expectedGeneration,
          transitionSource: "BACKOFFICE_HUMAN_UI",
        },
      },
    });
    const state = await tx.fleetLifecycleState.findUniqueOrThrow({ where: { appId: app.id } });
    return { state, event, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
