import { lockAppRow } from "./app-work-lock";
import { Prisma, type PrismaClient, type UserRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { PLATFORM_OUTCOME_UNKNOWN_CODE } from "@/lib/platform/operations";
import { jsonDigest } from "./json";
import { ControlPlaneError } from "./service";
import type { InternalPrincipal } from "./security";

export const appVisibilitySchema = z.object({
  appId: z.string().min(1).max(191),
  expectedUpdatedAt: z.string().datetime(),
  status: z.enum(["DEPRECATED", "ACTIVE", "PAUSED"]),
  reason: z.string().trim().min(1).max(500),
}).strict();

export type AppVisibilityActor =
  | { kind: "user"; login: string }
  | { kind: "internal"; principal: InternalPrincipal };

export function assertAppVisibilityAccess(subject: {
  role: UserRole; allowlisted: boolean; isOwner: boolean;
}): void {
  if (!subject.allowlisted || (subject.role !== "ADMIN" && !(subject.role === "MAINTAINER" && subject.isOwner))) {
    throw new ControlPlaneError("이 앱의 운영 상태를 변경할 권한이 없습니다.", 403, "APP_ACCESS_FORBIDDEN");
  }
}

export function assertAppVisibilityVersion(actual: Date, expected: string): void {
  if (actual.getTime() !== new Date(expected).getTime()) {
    throw new ControlPlaneError("앱 상태가 변경됐습니다. 최신 정보를 다시 확인해 주세요.", 409, "APP_VERSION_CONFLICT");
  }
}

/** 숨김과 복구는 같은 권한·CAS·멱등·감사 경계를 사용한다. 물리 삭제는 하지 않는다. */
export async function setAppVisibility(input: z.infer<typeof appVisibilitySchema> & {
  actor: AppVisibilityActor;
  requestId: string;
}, client: PrismaClient = prisma) {
  const request = appVisibilitySchema.parse({
    appId: input.appId, expectedUpdatedAt: input.expectedUpdatedAt, status: input.status, reason: input.reason,
  });
  const requestId = z.string().regex(/^[A-Za-z0-9._:/-]{8,191}$/).parse(input.requestId);
  const actor = input.actor.kind === "user" ? `user:${input.actor.login}` : input.actor.principal.id;
  const operation = "app.visibility";
  const targetKey = `App:${request.appId}`;
  const requestHash = jsonDigest({actor, operation, targetKey, request});

  try {
    return await client.$transaction(async (tx) => {
      // 앱 변경 및 동일 앱의 재요청을 직렬화한다. 재처리에도 현재 권한을 확인한다.
      await lockAppRow(tx, request.appId);
      const app = await tx.app.findUnique({
        where: {id: request.appId}, select: {id: true, slug: true, repoFullName: true, status: true, updatedAt: true},
      });
      if (!app) throw new ControlPlaneError("앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
      if (input.actor.kind === "internal") {
        const configured = process.env.CONTROL_PLANE_ADMIN_PRINCIPAL?.trim();
        if (!configured || input.actor.principal.audience !== "control-plane" || input.actor.principal.id !== configured) {
          throw new ControlPlaneError("중앙 운영 권한을 확인할 수 없습니다.", 403, "APP_ACCESS_FORBIDDEN");
        }
      } else {
        const user = await tx.user.findUnique({where: {login: input.actor.login}, select: {id: true, role: true, allowlisted: true}});
        const owner = user ? await tx.appOwner.findUnique({where: {appId_userId: {appId: app.id, userId: user.id}}}) : null;
        assertAppVisibilityAccess({role: user?.role ?? "VIEWER", allowlisted: user?.allowlisted ?? false, isOwner: owner?.role === "OWNER"});
      }
      const replay = await tx.automationMutationRequest.findUnique({where: {requestId}});
      if (replay) {
        if (replay.actor !== actor || replay.operation !== operation || replay.targetKey !== targetKey || replay.requestHash !== requestHash) {
          throw new ControlPlaneError("동일 요청 ID가 다른 앱 상태 변경에 사용됐습니다.", 409, "IDEMPOTENCY_CONFLICT");
        }
        if (replay.status !== "COMPLETED" || !replay.response) {
          throw new ControlPlaneError("요청 결과를 확인하지 못했습니다.", 409, "MUTATION_INCOMPLETE");
        }
        return {duplicate: true, response: replay.response};
      }
      assertAppVisibilityVersion(app.updatedAt, request.expectedUpdatedAt);
      if (request.status === "DEPRECATED") {
        const blockers = await Promise.all([
          tx.appOperationRun.count({where: {appId: app.id, OR: [
            {status: {in: ["PENDING", "PROCESSING"]}}, {error: PLATFORM_OUTCOME_UNKNOWN_CODE},
          ]}}),
          tx.agentRun.count({where: {appId: app.id, OR: [{status: {in: ["PENDING", "RUNNING"]}}, {repoGuard: {activeScopeKey: {not: null}}}]}}),
          tx.providerExecution.count({where: {appId: app.id, OR: [
            {status: {in: ["QUEUED", "WAITING_HUMAN_APPROVAL", "RUNNING", "READBACK_REQUIRED"]}},
            {activeScopeKey: {not: null}},
          ]}}),
          tx.releaseRecord.count({where: {appId: app.id, status: {in: ["PENDING", "IN_PROGRESS"]}}}),
          tx.operatorCommandRun.count({where: {appId: app.id, status: {in: ["PENDING", "PROCESSING"]}}}),
        ]);
        if (blockers.some((count) => count > 0)) {
          throw new ControlPlaneError("실행을 기다리거나 진행 중인 작업, 결과 확인이 필요한 작업이 있어 앱을 숨길 수 없습니다.", 409, "APP_HAS_ACTIVE_OPERATIONS");
        }
      }
      const updated = await tx.app.updateMany({
        where: {id: app.id, updatedAt: app.updatedAt, status: app.status}, data: {status: request.status},
      });
      if (updated.count !== 1) throw new ControlPlaneError("앱 상태 변경이 경합했습니다.", 409, "APP_VERSION_CONFLICT");
      const response = {appId: app.id, slug: app.slug, from: app.status, status: request.status};
      await tx.automationMutationRequest.create({data: {
        requestId, actor, operation, targetKey, requestHash, request,
        status: "COMPLETED", response, completedAt: new Date(),
      }});
      await tx.auditLog.create({data: {
        actorLogin: actor, action: operation, entityType: "App", entityId: app.id,
        payload: {requestId, ...response, reason: request.reason},
      }});
      return {duplicate: false, response};
    }, {isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted});
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ControlPlaneError("동일 요청 ID가 다른 상태 변경에 사용됐습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    throw error;
  }
}
