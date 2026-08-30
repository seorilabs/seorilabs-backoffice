/**
 * P2 Seori Auth Broker journal checkpoint의 MySQL 9.2 integration 계약이다. genesis,
 * strict generation==sequence CAS, deterministic idempotency 재생, unknown outcome
 * readback, append-only 감사 trigger의 실제 DB 동작을 검증한다.
 */

import assert from "node:assert/strict";

import {
  AUTH_BROKER_JOURNAL_CHECKPOINT_APPEND_ONLY_TRIGGERS,
  evaluateAppendOnlyTriggers,
  triggerVisibilityFromGrants,
  type ObservedTrigger,
} from "@/lib/control-plane/append-only-triggers";
import { AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST } from "@/lib/control-plane/auth-broker-journal-checkpoint";
import {
  advanceAuthBrokerJournalCheckpoint,
  genesisAuthBrokerJournalCheckpoint,
  readAuthBrokerJournalCheckpoint,
} from "@/lib/control-plane/auth-broker-journal-checkpoint-service";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("auth broker journal checkpoint integration fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("auth broker journal checkpoint integration fixture DB 이름은 _contract_test로 끝나야 한다");
}

const ACTOR = "spiffe://seorilabs.local/ns/auth-broker/sa/seori-auth-broker";
const JOURNAL_ID = "integration-nonce-journal";
const OTHER_JOURNAL_ID = "integration-second-journal";
const DIGEST_1 = "1".repeat(64);
const DIGEST_2 = "2".repeat(64);

async function expectControlPlaneError(code: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ControlPlaneError, `${code} 대신 ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  throw new Error(`${code}가 발생해야 했다`);
}

async function main() {
  // 1. genesis는 journalId별로 정확히 한 번만 실제 row를 만들고, 재호출은 멱등하다.
  const first = await genesisAuthBrokerJournalCheckpoint({ journalId: JOURNAL_ID, actor: ACTOR });
  assert.equal(first.created, true);
  assert.equal(first.checkpoint.generation, "0");
  assert.equal(first.checkpoint.sequence, "0");
  assert.equal(first.checkpoint.checkpointDigest, AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST);

  const replayedGenesis = await genesisAuthBrokerJournalCheckpoint({ journalId: JOURNAL_ID, actor: ACTOR });
  assert.equal(replayedGenesis.created, false);
  assert.deepEqual(replayedGenesis.checkpoint, first.checkpoint);

  const eventCountAfterGenesisReplay = await prisma.authBrokerJournalCheckpointEvent.count({
    where: { journalId: JOURNAL_ID },
  });
  assert.equal(eventCountAfterGenesisReplay, 1, "멱등 genesis 재호출이 event를 추가로 만들면 안 된다");

  // 2. 존재하지 않는 journalId의 advance는 genesis 없이 진행할 수 없다.
  await expectControlPlaneError("AUTH_BROKER_JOURNAL_CHECKPOINT_NOT_FOUND", () =>
    advanceAuthBrokerJournalCheckpoint({
      journalId: OTHER_JOURNAL_ID,
      expectedGeneration: 0n,
      expectedDigest: AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
      nextDigest: DIGEST_1,
      actor: ACTOR,
    }));

  // 3. exact expected/current/next 비교를 통과하는 CAS는 정확히 한 단계만 전진한다.
  const advanced = await advanceAuthBrokerJournalCheckpoint({
    journalId: JOURNAL_ID,
    expectedGeneration: 0n,
    expectedDigest: AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
    nextDigest: DIGEST_1,
    actor: ACTOR,
  });
  assert.equal(advanced.outcome, "ADVANCED");
  assert.equal(advanced.checkpoint.generation, "1");
  assert.equal(advanced.checkpoint.sequence, "1");
  assert.equal(advanced.checkpoint.checkpointDigest, DIGEST_1);

  // 4. 결정론적 idempotency key의 재시도는 REPLAYED로 같은 결과를 반환하고 새 row를 만들지 않는다.
  const replayedAdvance = await advanceAuthBrokerJournalCheckpoint({
    journalId: JOURNAL_ID,
    expectedGeneration: 0n,
    expectedDigest: AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
    nextDigest: DIGEST_1,
    actor: ACTOR,
  });
  assert.equal(replayedAdvance.outcome, "REPLAYED");
  assert.deepEqual(replayedAdvance.checkpoint, advanced.checkpoint);
  const eventCountAfterReplay = await prisma.authBrokerJournalCheckpointEvent.count({ where: { journalId: JOURNAL_ID } });
  assert.equal(eventCountAfterReplay, 2, "genesis 1건 + advance 1건만 있어야 한다(재생은 추가하지 않음)");

  // 5. stale expected(generation 0으로 재시도, 이미 1로 전진한 뒤)는 CAS_MISMATCH다.
  //    idempotency key가 이전과 달라야 replay 경로를 타지 않고 실제 CAS 비교를 거친다.
  await expectControlPlaneError("AUTH_BROKER_JOURNAL_CHECKPOINT_CAS_MISMATCH", () =>
    advanceAuthBrokerJournalCheckpoint({
      journalId: JOURNAL_ID,
      expectedGeneration: 0n,
      expectedDigest: AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
      nextDigest: DIGEST_2,
      actor: ACTOR,
    }));
  // mismatch는 상태를 바꾸지 않는다.
  const afterMismatch = await readAuthBrokerJournalCheckpoint({ journalId: JOURNAL_ID });
  assert.deepEqual(afterMismatch.checkpoint, advanced.checkpoint);

  // 6. expectedDigest만 틀려도(같은 generation) CAS_MISMATCH다.
  await expectControlPlaneError("AUTH_BROKER_JOURNAL_CHECKPOINT_CAS_MISMATCH", () =>
    advanceAuthBrokerJournalCheckpoint({
      journalId: JOURNAL_ID,
      expectedGeneration: 1n,
      expectedDigest: AUTH_BROKER_JOURNAL_CHECKPOINT_GENESIS_DIGEST,
      nextDigest: DIGEST_2,
      actor: ACTOR,
    }));

  // 7. "unknown outcome readback": 올바른 다음 단계는 read route가 이미 반영된 상태를 그대로 보여준다.
  const secondAdvance = await advanceAuthBrokerJournalCheckpoint({
    journalId: JOURNAL_ID,
    expectedGeneration: 1n,
    expectedDigest: DIGEST_1,
    nextDigest: DIGEST_2,
    actor: ACTOR,
  });
  assert.equal(secondAdvance.outcome, "ADVANCED");
  assert.equal(secondAdvance.checkpoint.generation, "2");
  const readback = await readAuthBrokerJournalCheckpoint({ journalId: JOURNAL_ID });
  assert.deepEqual(readback.checkpoint, secondAdvance.checkpoint);

  // 8. 존재하지 않는 journalId의 read는 checkpoint: null이다(에러가 아니다).
  const missing = await readAuthBrokerJournalCheckpoint({ journalId: "never-created-journal" });
  assert.deepEqual(missing, { checkpoint: null });

  // 9. 서로 다른 journalId는 독립된 counter다.
  const secondJournal = await genesisAuthBrokerJournalCheckpoint({ journalId: OTHER_JOURNAL_ID, actor: ACTOR });
  assert.equal(secondJournal.checkpoint.generation, "0");
  const stillTwo = await readAuthBrokerJournalCheckpoint({ journalId: JOURNAL_ID });
  assert.equal(stillTwo.checkpoint?.generation, "2", "다른 journalId genesis가 기존 journal에 영향을 주면 안 된다");

  // 10. append-only 감사: live trigger readback이 계약과 정확히 같다.
  const [schemaRow] = await prisma.$queryRawUnsafe<Array<{ schemaName: string }>>("SELECT DATABASE() AS schemaName");
  const grantRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("SHOW GRANTS FOR CURRENT_USER()");
  const grants = grantRows.map((row) => String(Object.values(row)[0] ?? ""));
  const visibility = triggerVisibilityFromGrants(
    grants,
    schemaRow.schemaName,
    AUTH_BROKER_JOURNAL_CHECKPOINT_APPEND_ONLY_TRIGGERS,
  );
  const observedRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT
      TRIGGER_NAME AS name,
      EVENT_OBJECT_TABLE AS tableName,
      EVENT_MANIPULATION AS event,
      ACTION_TIMING AS timing,
      ACTION_STATEMENT AS statement
    FROM information_schema.TRIGGERS
    WHERE TRIGGER_SCHEMA = DATABASE()
    ORDER BY TRIGGER_NAME
  `);
  const observed: ObservedTrigger[] = observedRows.map((row) => ({
    name: String(row.name ?? ""),
    table: String(row.tableName ?? ""),
    event: String(row.event ?? ""),
    timing: String(row.timing ?? ""),
    statement: String(row.statement ?? ""),
  }));
  const evaluation = evaluateAppendOnlyTriggers({
    visibility,
    observed,
    required: AUTH_BROKER_JOURNAL_CHECKPOINT_APPEND_ONLY_TRIGGERS,
  });
  assert.equal(evaluation.visibility, "VISIBLE");
  assert.equal(evaluation.verified, AUTH_BROKER_JOURNAL_CHECKPOINT_APPEND_ONLY_TRIGGERS.length);

  // 11. trigger가 실제로 UPDATE/DELETE를 막는다(SQL 수준 강제, 애플리케이션 코드 경로와 무관).
  const anyEvent = await prisma.authBrokerJournalCheckpointEvent.findFirstOrThrow({ where: { journalId: JOURNAL_ID } });
  await assert.rejects(
    () => prisma.$executeRawUnsafe(
      `UPDATE control_plane_auth_broker_journal_checkpoint_event SET actor = 'tampered' WHERE id = ?`,
      anyEvent.id,
    ),
    /append-only/,
  );
  await assert.rejects(
    () => prisma.$executeRawUnsafe(
      `DELETE FROM control_plane_auth_broker_journal_checkpoint_event WHERE id = ?`,
      anyEvent.id,
    ),
    /append-only/,
  );
  // 강제 시도 뒤에도 원래 값이 그대로 남아 있어야 한다.
  const untouched = await prisma.authBrokerJournalCheckpointEvent.findUniqueOrThrow({ where: { id: anyEvent.id } });
  assert.equal(untouched.actor, ACTOR);

  // 12. 감사 원장에는 secret 후보 필드가 없다 — digest·counter·SPIFFE identity 문자열뿐이다.
  const allEvents = await prisma.authBrokerJournalCheckpointEvent.findMany({ where: { journalId: JOURNAL_ID } });
  for (const event of allEvents) {
    assert.equal(Object.keys(event).some((key) => /secret|token|password|cookie|totp/i.test(key)), false);
  }

  console.log("auth broker journal checkpoint 계약 통과");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
