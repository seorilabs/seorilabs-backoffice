import assert from "node:assert/strict";
import test from "node:test";

import {
  authBrokerJournalCheckpointAdvanceRequestSchema,
  authBrokerJournalCheckpointAdvanceResponseSchema,
  authBrokerJournalCheckpointGenesisRequestSchema,
  authBrokerJournalCheckpointGenesisResponseSchema,
  authBrokerJournalCheckpointReadRequestSchema,
  authBrokerJournalCheckpointReadResponseSchema,
  authBrokerJournalCheckpointStateSchema,
} from "@/lib/control-plane/contracts";
import {
  AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
  assertAuthBrokerJournalCheckpointInvariant,
  assertAuthBrokerJournalId,
  authBrokerJournalCheckpointAdvanceIdempotencyKey,
  authBrokerJournalCheckpointGenesisIdempotencyKey,
  serializeAuthBrokerJournalCheckpoint,
} from "@/lib/control-plane/auth-broker-journal-checkpoint";

test("genesis digest는 고정된 opaque sha256이다", () => {
  assert.match(AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST, /^[0-9a-f]{64}$/);
  // 재계산해도 항상 같은 값이어야 한다 — broker 재시작마다 같은 genesis state로 시작한다.
  assert.equal(AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST, AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST);
});

test("journalId 형식 검증", () => {
  assert.doesNotThrow(() => assertAuthBrokerJournalId("nonce-journal"));
  assert.doesNotThrow(() => assertAuthBrokerJournalId("a"));
  assert.doesNotThrow(() => assertAuthBrokerJournalId("seori-auth-broker:nonce.v1"));
  for (const invalid of ["", "Nonce-Journal", "-leading-dash", ".leading-dot", "has space", "a".repeat(192)]) {
    assert.throws(() => assertAuthBrokerJournalId(invalid), /AUTH_BROKER_JOURNAL_ID_INVALID/);
  }
});

test("genesis idempotency key는 journalId에서만 결정된다", () => {
  const first = authBrokerJournalCheckpointGenesisIdempotencyKey("nonce-journal");
  const second = authBrokerJournalCheckpointGenesisIdempotencyKey("nonce-journal");
  assert.equal(first, second);
  assert.equal(first, "journal-genesis:nonce-journal");
  assert.notEqual(first, authBrokerJournalCheckpointGenesisIdempotencyKey("other-journal"));
});

test("advance idempotency key는 (journalId, expectedGeneration, nextDigest)에서만 결정된다", () => {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const key = (overrides: Partial<{ journalId: string; expectedGeneration: bigint; nextDigest: string }> = {}) =>
    authBrokerJournalCheckpointAdvanceIdempotencyKey({
      journalId: "nonce-journal",
      expectedGeneration: 0n,
      nextDigest: digestA,
      ...overrides,
    });

  assert.equal(key(), key());
  assert.equal(key(), "journal-cas:nonce-journal:0:" + digestA);
  assert.notEqual(key(), key({ journalId: "other-journal" }));
  assert.notEqual(key(), key({ expectedGeneration: 1n }));
  assert.notEqual(key(), key({ nextDigest: digestB }));

  assert.throws(
    () => authBrokerJournalCheckpointAdvanceIdempotencyKey({ journalId: "x", expectedGeneration: -1n, nextDigest: digestA }),
    /AUTH_BROKER_JOURNAL_EXPECTED_GENERATION_INVALID/,
  );
  assert.throws(
    () => authBrokerJournalCheckpointAdvanceIdempotencyKey({ journalId: "x", expectedGeneration: 0n, nextDigest: "not-hex" }),
    /AUTH_BROKER_JOURNAL_NEXT_DIGEST_INVALID/,
  );
});

test("strict generation==sequence 불변식", () => {
  assert.doesNotThrow(() => assertAuthBrokerJournalCheckpointInvariant({ generation: 0n, sequence: 0n }));
  assert.doesNotThrow(() => assertAuthBrokerJournalCheckpointInvariant({ generation: 42n, sequence: 42n }));
  assert.throws(
    () => assertAuthBrokerJournalCheckpointInvariant({ generation: 5n, sequence: 4n }),
    /AUTH_BROKER_JOURNAL_CHECKPOINT_INVARIANT_VIOLATION/,
  );
  assert.throws(
    () => assertAuthBrokerJournalCheckpointInvariant({ generation: 4n, sequence: 5n }),
    /AUTH_BROKER_JOURNAL_CHECKPOINT_INVARIANT_VIOLATION/,
  );
});

test("직렬화는 bigint/Date를 계약이 요구하는 문자열로 바꾼다", () => {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const serialized = serializeAuthBrokerJournalCheckpoint({
    journalId: "nonce-journal",
    generation: 3n,
    sequence: 3n,
    checkpointDigest: "c".repeat(64),
    updatedAt: now,
  });
  assert.deepEqual(serialized, {
    journalId: "nonce-journal",
    generation: "3",
    sequence: "3",
    checkpointDigest: "c".repeat(64),
    updatedAt: "2026-08-30T00:00:00.000Z",
  });
  // 계약 schema를 그대로 통과해야 한다(응답 body 형태와 정확히 같아야 함).
  assert.doesNotThrow(() => authBrokerJournalCheckpointStateSchema.parse(serialized));
});

test("genesis 요청/응답 계약은 journalId 외 필드를 거부한다", () => {
  assert.doesNotThrow(() => authBrokerJournalCheckpointGenesisRequestSchema.parse({ journalId: "nonce-journal" }));
  assert.throws(() => authBrokerJournalCheckpointGenesisRequestSchema.parse({ journalId: "nonce-journal", extra: 1 }));
  assert.throws(() => authBrokerJournalCheckpointGenesisRequestSchema.parse({}));

  const state = {
    journalId: "nonce-journal",
    generation: "0",
    sequence: "0",
    checkpointDigest: AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
    updatedAt: new Date().toISOString(),
  };
  assert.doesNotThrow(() => authBrokerJournalCheckpointGenesisResponseSchema.parse({ checkpoint: state, created: true }));
  // secret/token/cookie/TOTP 후보 필드가 없다 — 계약 자체가 opaque digest와 카운터만 허용한다.
  assert.throws(() =>
    authBrokerJournalCheckpointGenesisResponseSchema.parse({
      checkpoint: { ...state, secret: "should-not-exist" },
      created: true,
    }));
});

test("read 요청/응답 계약", () => {
  assert.doesNotThrow(() => authBrokerJournalCheckpointReadRequestSchema.parse({ journalId: "nonce-journal" }));
  assert.doesNotThrow(() => authBrokerJournalCheckpointReadResponseSchema.parse({ checkpoint: null }));
});

test("advance 요청 계약은 exact expected/next 필드만 허용한다", () => {
  const digest = "d".repeat(64);
  assert.doesNotThrow(() =>
    authBrokerJournalCheckpointAdvanceRequestSchema.parse({
      journalId: "nonce-journal",
      expectedGeneration: 0,
      expectedDigest: AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
      nextDigest: digest,
    }));
  // 호출자가 idempotencyKey나 nextGeneration을 직접 고를 수 없다 — 서버가 유도한다.
  assert.throws(() =>
    authBrokerJournalCheckpointAdvanceRequestSchema.parse({
      journalId: "nonce-journal",
      expectedGeneration: 0,
      expectedDigest: AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
      nextDigest: digest,
      idempotencyKey: "client-chosen",
    }));
  assert.throws(() =>
    authBrokerJournalCheckpointAdvanceRequestSchema.parse({
      journalId: "nonce-journal",
      expectedGeneration: -1,
      expectedDigest: AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
      nextDigest: digest,
    }));
  assert.doesNotThrow(() =>
    authBrokerJournalCheckpointAdvanceResponseSchema.parse({
      outcome: "ADVANCED",
      checkpoint: {
        journalId: "nonce-journal",
        generation: "1",
        sequence: "1",
        checkpointDigest: digest,
        updatedAt: new Date().toISOString(),
      },
    }));
});
