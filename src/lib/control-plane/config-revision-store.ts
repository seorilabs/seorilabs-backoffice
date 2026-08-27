import { Prisma } from "@prisma/client";

/**
 * 사람이 만든 DRAFT와 shadow import DRAFT가 같은 revision allocation 경로를 쓴다.
 * 호출자는 app row를 FOR UPDATE로 잠그고 payload를 공용 validator로 검증해야 한다.
 */
export async function createDraftRevisionInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    appId: string;
    payload: Record<string, unknown>;
    payloadHash: string;
    createdBy: string;
    idempotencyKey: string;
  },
) {
  const latest = await tx.configRevision.aggregate({
    where: { appId: input.appId },
    _max: { revision: true },
  });
  return tx.configRevision.create({
    data: {
      appId: input.appId,
      revision: (latest._max.revision ?? 0) + 1,
      status: "DRAFT",
      payload: input.payload as Prisma.InputJsonValue,
      payloadHash: input.payloadHash,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
    },
  });
}
