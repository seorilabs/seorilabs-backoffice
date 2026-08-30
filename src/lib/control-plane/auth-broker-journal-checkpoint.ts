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

/** journalId별 genesis row 생성은 멱등이다. 같은 journalId는 항상 같은 idempotency key다. */
export function authBrokerJournalCheckpointGenesisIdempotencyKey(journalId: string): string {
  assertAuthBrokerJournalId(journalId);
  return `journal-genesis:${journalId}`;
}

/**
 * CAS advance의 idempotency key는 (journalId, expectedGeneration, nextDigest) 세 값에서만
 * 결정된다. 호출자가 key를 직접 고르지 않는다 — 서버가 요청 필드에서 유도해, 같은 논리
 * 연산의 재시도는 항상 같은 key로 수렴하고 다른 연산은 항상 다른 key가 된다.
 */
export function authBrokerJournalCheckpointAdvanceIdempotencyKey(input: {
  journalId: string;
  expectedGeneration: bigint;
  nextDigest: string;
}): string {
  assertAuthBrokerJournalId(input.journalId);
  if (input.expectedGeneration < 0n) throw new Error("AUTH_BROKER_JOURNAL_EXPECTED_GENERATION_INVALID");
  if (!/^[0-9a-f]{64}$/.test(input.nextDigest)) throw new Error("AUTH_BROKER_JOURNAL_NEXT_DIGEST_INVALID");
  return `journal-cas:${input.journalId}:${input.expectedGeneration.toString()}:${input.nextDigest}`;
}

/**
 * genesis 대비 강제 불변식 검증이다. 현재 row의 generation과 sequence가 다르면 데이터가
 * 계약 밖에서 바뀐 것이므로 CAS를 시도하지 않고 즉시 예외를 던진다.
 */
export function assertAuthBrokerJournalCheckpointInvariant(input: {
  generation: bigint;
  sequence: bigint;
}): void {
  if (input.generation !== input.sequence) {
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
