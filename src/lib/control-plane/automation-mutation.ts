import crypto from "node:crypto";
import { Prisma } from "@prisma/client";

import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";
import { ControlPlaneError } from "@/lib/control-plane/service";

interface MutationIdentity {
  requestId: string;
  actor: string;
  operation: string;
  targetKey: string;
  request: JsonValue;
}

export function automationMutationRequestHash(input: Omit<MutationIdentity, "requestId">): string {
  return crypto.createHash("sha256").update(canonicalJson(input as unknown as JsonValue)).digest("hex");
}

function publicJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value, (_key, child) => (
    typeof child === "bigint" ? child.toString() : child
  ))) as JsonValue;
}

export function automationMutationIdentityMatches(
  row: { actor: string; operation: string; targetKey: string; requestHash: string },
  input: MutationIdentity,
  hash: string,
): boolean {
  return row.actor === input.actor
    && row.operation === input.operation
    && row.targetKey === input.targetKey
    && row.requestHash === hash;
}

export async function beginAutomationMutation(input: MutationIdentity): Promise<{
  requestHash: string;
  replay: JsonValue | null;
}> {
  const hash = automationMutationRequestHash(input);
  const created = await prisma.automationMutationRequest.createMany({
    data: [{
      requestId: input.requestId,
      actor: input.actor,
      operation: input.operation,
      targetKey: input.targetKey,
      requestHash: hash,
      request: input.request as Prisma.InputJsonValue,
    }],
    skipDuplicates: true,
  });
  if (created.count === 1) {
    return { requestHash: hash, replay: null };
  }
  const row = await prisma.automationMutationRequest.findUnique({ where: { requestId: input.requestId } });
  if (!row || !automationMutationIdentityMatches(row, input, hash)) {
    throw new ControlPlaneError(
      "idempotency key가 다른 automation mutation에 사용되었습니다.",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
  return {
    requestHash: hash,
    replay: row.status === "COMPLETED" && row.response !== null ? row.response as JsonValue : null,
  };
}

/**
 * 상태 mutation과 동일 request의 audit 완료를 하나의 CAS transaction으로 봉인한다.
 * 두 재처리가 동시에 끝나도 한 요청당 audit row는 정확히 하나만 생성된다.
 */
export async function completeAutomationMutation(input: MutationIdentity & {
  requestHash: string;
  response: unknown;
  audit: {
    action: string;
    entityType: string;
    entityId?: string | null;
    payload?: JsonValue;
  };
}): Promise<JsonValue> {
  const response = publicJson(input.response);
  const result = await prisma.$transaction(async (tx) => {
    const completed = await tx.automationMutationRequest.updateMany({
      where: {
        requestId: input.requestId,
        actor: input.actor,
        operation: input.operation,
        targetKey: input.targetKey,
        requestHash: input.requestHash,
        status: "PENDING",
      },
      data: { status: "COMPLETED", response: response as Prisma.InputJsonValue, completedAt: new Date() },
    });
    if (completed.count === 1) {
      await tx.auditLog.create({
        data: {
          actorLogin: input.actor,
          action: input.audit.action,
          entityType: input.audit.entityType,
          entityId: input.audit.entityId ?? null,
          payload: {
            requestId: input.requestId,
            ...(input.audit.payload ? { request: input.audit.payload } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      return response;
    }
    const replay = await tx.automationMutationRequest.findUnique({ where: { requestId: input.requestId } });
    if (!replay || replay.status !== "COMPLETED" || replay.response === null) {
      throw new ControlPlaneError("automation mutation 완료 CAS에 실패했습니다.", 409, "MUTATION_CAS_CONFLICT");
    }
    return replay.response as JsonValue;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return result;
}
