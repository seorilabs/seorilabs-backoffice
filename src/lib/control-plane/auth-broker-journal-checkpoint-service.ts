/**
 * P2 Seori Auth Broker journal checkpoint의 Backoffice durable authority다. DB CAS,
 * idempotent genesis, append-only 감사를 담당한다. 순수 계산은
 * `auth-broker-journal-checkpoint.ts`에 있다.
 */

import { Prisma } from "@prisma/client";

import {
  AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
  assertAuthBrokerJournalCheckpointInvariant,
  assertAuthBrokerJournalId,
  authBrokerJournalCheckpointAdvanceIdempotencyKey,
  authBrokerJournalCheckpointGenesisIdempotencyKey,
  serializeAuthBrokerJournalCheckpoint,
  type AuthBrokerJournalCheckpointRow,
} from "@/lib/control-plane/auth-broker-journal-checkpoint";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

type SerializedCheckpoint = ReturnType<typeof serializeAuthBrokerJournalCheckpoint>;

/** genesis에서 재검증 없이 반환하지 않는다 — row-version과 broker 위치가 어긋난 데이터를
 * 절대 caller에게 내보내지 않는다. */
function assertInvariantOrFailClosed(row: AuthBrokerJournalCheckpointRow): void {
  try {
    assertAuthBrokerJournalCheckpointInvariant(row);
  } catch {
    throw new ControlPlaneError(
      "journal checkpoint의 generation과 sequence가 어긋났습니다.",
      500,
      "AUTH_BROKER_JOURNAL_CHECKPOINT_INVARIANT_VIOLATION",
    );
  }
}

/**
 * journalId별 genesis row를 멱등 생성한다. 이미 있으면 새로 만들지 않고 기존 row를
 * `created: false`로 반환한다 — genesis는 broker가 재시작할 때마다 안전하게 재호출할 수
 * 있어야 한다.
 */
export async function genesisAuthBrokerJournalCheckpoint(input: {
  journalId: string;
  actor: string;
}): Promise<{ checkpoint: SerializedCheckpoint; created: boolean }> {
  assertAuthBrokerJournalId(input.journalId);
  const idempotencyKey = authBrokerJournalCheckpointGenesisIdempotencyKey(input.journalId);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const checkpoint = await tx.authBrokerJournalCheckpoint.create({
        data: {
          journalId: input.journalId,
          generation: 0n,
          sequence: 0n,
          checkpointDigest: AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
          updatedBy: input.actor,
        },
      });
      await tx.authBrokerJournalCheckpointEvent.create({
        data: {
          checkpointId: checkpoint.id,
          journalId: checkpoint.journalId,
          requestId: idempotencyKey,
          type: "GENESIS",
          toGeneration: 0n,
          toSequence: 0n,
          toDigest: AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
          actor: input.actor,
        },
      });
      return checkpoint;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    assertInvariantOrFailClosed(created);
    return { checkpoint: serializeAuthBrokerJournalCheckpoint(created), created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.authBrokerJournalCheckpoint.findUnique({
        where: { journalId: input.journalId },
      });
      if (existing) {
        assertInvariantOrFailClosed(existing);
        return { checkpoint: serializeAuthBrokerJournalCheckpoint(existing), created: false };
      }
    }
    throw error;
  }
}

/**
 * "unknown outcome readback"의 유일한 진입점이다. broker가 advance 응답을 잃었을 때,
 * 자신이 결정론적으로 재구성한 idempotency key와 이 route의 현재 generation/digest를
 * 비교해 자신의 마지막 시도가 반영됐는지 스스로 판정한다. Backoffice는 event 조회를
 * 제공하지 않는다 — 현재 상태 하나면 충분하다.
 */
export async function readAuthBrokerJournalCheckpoint(input: {
  journalId: string;
}): Promise<{ checkpoint: SerializedCheckpoint | null }> {
  assertAuthBrokerJournalId(input.journalId);
  const existing = await prisma.authBrokerJournalCheckpoint.findUnique({
    where: { journalId: input.journalId },
  });
  if (!existing) return { checkpoint: null };
  assertInvariantOrFailClosed(existing);
  return { checkpoint: serializeAuthBrokerJournalCheckpoint(existing) };
}

/**
 * strict generation==sequence CAS. `expectedGeneration`/`expectedDigest`(expected)가
 * 현재 row(current)와 정확히 같을 때만 `expectedGeneration+1`(next)로 정확히 한 단계
 * 전진한다. idempotency key는 (journalId, expectedGeneration, expectedDigest, nextDigest)에서
 * 결정되므로
 * 같은 논리 연산의 재시도는 새 row를 만들지 않고 처음 결과를 그대로 반환한다(`REPLAYED`).
 */
export async function advanceAuthBrokerJournalCheckpoint(input: {
  journalId: string;
  expectedGeneration: bigint;
  expectedDigest: string;
  nextDigest: string;
  actor: string;
}): Promise<{ outcome: "ADVANCED" | "REPLAYED"; checkpoint: SerializedCheckpoint }> {
  assertAuthBrokerJournalId(input.journalId);
  if (input.expectedGeneration < 0n) {
    throw new ControlPlaneError("expectedGeneration이 음수입니다.", 400, "AUTH_BROKER_JOURNAL_CHECKPOINT_EXPECTED_GENERATION_INVALID");
  }
  const idempotencyKey = authBrokerJournalCheckpointAdvanceIdempotencyKey({
    journalId: input.journalId,
    expectedGeneration: input.expectedGeneration,
    expectedDigest: input.expectedDigest,
    nextDigest: input.nextDigest,
  });

  const replay = await replayAdvance({ ...input, idempotencyKey });
  if (replay) return replay;

  const nextGeneration = input.expectedGeneration + 1n;
  try {
    const advanced = await prisma.$transaction(async (tx) => {
      const changed = await tx.authBrokerJournalCheckpoint.updateMany({
        where: {
          journalId: input.journalId,
          generation: input.expectedGeneration,
          sequence: input.expectedGeneration,
          checkpointDigest: input.expectedDigest,
        },
        data: {
          generation: nextGeneration,
          sequence: nextGeneration,
          checkpointDigest: input.nextDigest,
          updatedBy: input.actor,
        },
      });
      if (changed.count !== 1) {
        const current = await tx.authBrokerJournalCheckpoint.findUnique({
          where: { journalId: input.journalId },
        });
        if (!current) {
          throw new ControlPlaneError(
            "journalId의 genesis row가 없습니다. genesis를 먼저 호출해야 합니다.",
            404,
            "AUTH_BROKER_JOURNAL_CHECKPOINT_NOT_FOUND",
          );
        }
        assertInvariantOrFailClosed(current);
        throw new ControlPlaneError(
          "expected checkpoint 상태가 현재 상태와 다릅니다.",
          409,
          "AUTH_BROKER_JOURNAL_CHECKPOINT_CAS_MISMATCH",
        );
      }
      const checkpoint = await tx.authBrokerJournalCheckpoint.findUniqueOrThrow({
        where: { journalId: input.journalId },
      });
      assertInvariantOrFailClosed(checkpoint);
      await tx.authBrokerJournalCheckpointEvent.create({
        data: {
          checkpointId: checkpoint.id,
          journalId: input.journalId,
          requestId: idempotencyKey,
          type: "ADVANCED",
          fromGeneration: input.expectedGeneration,
          toGeneration: nextGeneration,
          fromSequence: input.expectedGeneration,
          toSequence: nextGeneration,
          fromDigest: input.expectedDigest,
          toDigest: input.nextDigest,
          actor: input.actor,
        },
      });
      return checkpoint;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    assertInvariantOrFailClosed(advanced);
    return { outcome: "ADVANCED", checkpoint: serializeAuthBrokerJournalCheckpoint(advanced) };
  } catch (error) {
    // 같은 logical request가 동시에 먼저 커밋했으면 updateMany CAS 실패나 transaction
    // conflict 형태가 달라도 exact event readback으로 처음 결과에 수렴한다.
    const replayed = await replayAdvanceAfterConcurrentOutcome({ ...input, idempotencyKey }, error);
    if (replayed) return replayed;
    throw error;
  }
}

async function replayAdvanceAfterConcurrentOutcome(
  input: Parameters<typeof replayAdvance>[0],
  error: unknown,
): Promise<Awaited<ReturnType<typeof replayAdvance>>> {
  const isConcurrentConflict =
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034");
  const attempts = isConcurrentConflict ? 6 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const replayed = await replayAdvance(input);
    if (replayed) return replayed;
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  return null;
}

async function replayAdvance(input: {
  idempotencyKey: string;
  journalId: string;
  expectedGeneration: bigint;
  expectedDigest: string;
  nextDigest: string;
}): Promise<{ outcome: "REPLAYED"; checkpoint: SerializedCheckpoint } | null> {
  const event = await prisma.authBrokerJournalCheckpointEvent.findUnique({
    where: { requestId: input.idempotencyKey },
  });
  if (!event) return null;
  const nextGeneration = input.expectedGeneration + 1n;
  if (
    event.type !== "ADVANCED"
    || event.journalId !== input.journalId
    || event.fromGeneration !== input.expectedGeneration
    || event.toGeneration !== nextGeneration
    || event.fromSequence !== input.expectedGeneration
    || event.toSequence !== nextGeneration
    || event.fromDigest !== input.expectedDigest
    || event.toDigest !== input.nextDigest
  ) {
    throw new ControlPlaneError(
      "idempotency key가 다른 journal checkpoint 연산에 사용되었습니다.",
      409,
      "AUTH_BROKER_JOURNAL_CHECKPOINT_IDEMPOTENCY_CONFLICT",
    );
  }
  const checkpoint = await prisma.authBrokerJournalCheckpoint.findUnique({ where: { id: event.checkpointId } });
  if (!checkpoint) {
    throw new ControlPlaneError(
      "replay할 checkpoint row를 찾을 수 없습니다.",
      409,
      "AUTH_BROKER_JOURNAL_CHECKPOINT_REPLAY_MISSING",
    );
  }
  assertInvariantOrFailClosed(checkpoint);
  if (
    checkpoint.generation !== nextGeneration
    || checkpoint.sequence !== nextGeneration
    || checkpoint.checkpointDigest !== input.nextDigest
  ) {
    throw new ControlPlaneError(
      "replay 대상 checkpoint가 이미 다른 상태로 전진했습니다.",
      409,
      "AUTH_BROKER_JOURNAL_CHECKPOINT_REPLAY_STATE_MISMATCH",
    );
  }
  return { outcome: "REPLAYED", checkpoint: serializeAuthBrokerJournalCheckpoint(checkpoint) };
}
