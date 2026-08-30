/**
 * P2 Seori Auth Broker journal checkpoint의 순수 로직이다. DB를 만지지 않는다
 * (`auth-broker-journal-checkpoint-service.ts`가 그 경계를 맡는다).
 *
 * 정상 진행에서는 항상 `generation === sequence`다. generation은 Backoffice가 매
 * 성공한 advance마다 1씩 올리는 row-version CAS counter이고, sequence는 broker가 commit한
 * 논리 journal 위치다. 둘 다 genesis에서 0으로 시작해 매 advance가 정확히 1씩만 전진시키므로
 * 두 값은 귀납적으로 항상 같다. 어긋나면(변조·직접 DB 조작·다른 writer) 즉시 fail-closed한다
 * — 자동 복구하지 않는다.
 */

import { jsonDigest } from "@/lib/control-plane/json";

/** genesis row가 시작하는 고정 opaque digest. secret이 아니며 broker 실제 데이터가 아니다. */
export const AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST = jsonDigest({
  schema: "auth-broker-journal-checkpoint-genesis-v1",
});

export const AUTH_BROKER_JOURNAL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,190}$/;

export function assertAuthBrokerJournalId(journalId: string): void {
  if (!AUTH_BROKER_JOURNAL_ID_PATTERN.test(journalId)) {
    throw new Error("AUTH_BROKER_JOURNAL_ID_INVALID");
  }
}

/** journalId별 genesis row 생성은 멱등이다. 같은 journalId는 항상 같은 고정 길이 key다. */
export function authBrokerJournalCheckpointGenesisIdempotencyKey(journalId: string): string {
  assertAuthBrokerJournalId(journalId);
  return `journal-genesis:${jsonDigest({ schemaVersion: 1, journalId })}`;
}

/**
 * CAS advance의 idempotency key는 exact expected/current/next binding 전체에서 결정된다.
 * 고정 길이 digest를 써 journalId 최대 길이에서도 DB VARCHAR(191)를 넘지 않는다.
 */
export function authBrokerJournalCheckpointAdvanceIdempotencyKey(input: {
  journalId: string;
  expectedGeneration: bigint;
  expectedDigest: string;
  nextDigest: string;
}): string {
  assertAuthBrokerJournalId(input.journalId);
  if (input.expectedGeneration < 0n) throw new Error("AUTH_BROKER_JOURNAL_EXPECTED_GENERATION_INVALID");
  if (!/^[0-9a-f]{64}$/.test(input.expectedDigest)) throw new Error("AUTH_BROKER_JOURNAL_EXPECTED_DIGEST_INVALID");
  if (!/^[0-9a-f]{64}$/.test(input.nextDigest)) throw new Error("AUTH_BROKER_JOURNAL_NEXT_DIGEST_INVALID");
  return `journal-cas:${jsonDigest({
    schemaVersion: 1,
    journalId: input.journalId,
    expectedGeneration: input.expectedGeneration.toString(),
    expectedDigest: input.expectedDigest,
    nextDigest: input.nextDigest,
  })}`;
}

/**
 * genesis 대비 강제 불변식 검증이다. 현재 row의 generation과 sequence가 다르면 데이터가
 * 계약 밖에서 바뀐 것이므로 CAS를 시도하지 않고 즉시 예외를 던진다.
 */
export function assertAuthBrokerJournalCheckpointInvariant(input: {
  journalId: string;
  generation: bigint;
  sequence: bigint;
  checkpointDigest: string;
}): void {
  if (
    !AUTH_BROKER_JOURNAL_ID_PATTERN.test(input.journalId)
    || input.generation < 0n
    || input.sequence < 0n
    || input.generation !== input.sequence
    || !/^[0-9a-f]{64}$/.test(input.checkpointDigest)
  ) {
    throw new Error("AUTH_BROKER_JOURNAL_CHECKPOINT_INVARIANT_VIOLATION");
  }
}

export interface AuthBrokerJournalCheckpointRow {
  journalId: string;
  generation: bigint;
  sequence: bigint;
  checkpointDigest: string;
  updatedAt: Date;
}

/** 응답 계약(`authBrokerJournalCheckpointStateSchema`)이 요구하는 문자열/ISO 표현으로 옮긴다. */
export function serializeAuthBrokerJournalCheckpoint(row: AuthBrokerJournalCheckpointRow): {
  journalId: string;
  generation: string;
  sequence: string;
  checkpointDigest: string;
  updatedAt: string;
} {
  return {
    journalId: row.journalId,
    generation: row.generation.toString(),
    sequence: row.sequence.toString(),
    checkpointDigest: row.checkpointDigest,
    updatedAt: row.updatedAt.toISOString(),
  };
}
