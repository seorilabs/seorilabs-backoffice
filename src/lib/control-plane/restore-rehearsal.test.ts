import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIsolatedRehearsalDatabaseUrl,
  ensureRestoredAppendOnlyTriggers,
  isolatedRehearsalDatabaseUrl,
} from "@/lib/control-plane/restore-rehearsal";
import {
  REQUIRED_APPEND_ONLY_TRIGGERS,
  appendOnlyActionStatement,
  appendOnlyContractDigest,
  type ObservedTrigger,
} from "@/lib/control-plane/append-only-triggers";

function observation(index: number): ObservedTrigger {
  const requirement = REQUIRED_APPEND_ONLY_TRIGGERS[index]!;
  return {
    name: requirement.name,
    table: requirement.table,
    event: requirement.event,
    timing: "BEFORE",
    statement: appendOnlyActionStatement(requirement.message),
  };
}

class FakeTriggerClient {
  readonly statements: string[] = [];

  constructor(
    readonly observed: ObservedTrigger[],
    readonly grant = "GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost`",
  ) {}

  async $queryRawUnsafe<T>(query: string): Promise<T> {
    if (query.includes("SELECT DATABASE()")) {
      return [{ schemaName: "backoffice_rehearsal" }] as T;
    }
    if (query.includes("SHOW GRANTS")) {
      return [{ grant: this.grant }] as T;
    }
    return this.observed.map((trigger) => ({
      name: trigger.name,
      tableName: trigger.table,
      event: trigger.event,
      timing: trigger.timing,
      statement: trigger.statement,
    })) as T;
  }

  async executeTriggerDdl(statement: string): Promise<void> {
    this.statements.push(statement);
    const index = REQUIRED_APPEND_ONLY_TRIGGERS.findIndex(({ name }) => statement.includes(name));
    assert.ok(index >= 0, "계약에 없는 DDL이 실행됐다");
    this.observed.push(observation(index));
  }
}

test("restore rehearsal DB는 loopback의 고정 격리 database만 허용한다", () => {
  const url = isolatedRehearsalDatabaseUrl({ host: "127.0.0.1", password: "temporary-pass" });
  assert.doesNotThrow(() => assertIsolatedRehearsalDatabaseUrl(url));
  assert.doesNotThrow(() => assertIsolatedRehearsalDatabaseUrl(
    "mysql://root:test@localhost:3306/backoffice_empty_contract_test",
  ));
  for (const unsafe of [
    "mysql://root:x@mysql.data.svc.cluster.local:3306/backoffice",
    "mysql://root:x@127.0.0.1:3306/backoffice",
    "postgresql://root:x@127.0.0.1:5432/backoffice_rehearsal",
  ]) {
    assert.throws(() => assertIsolatedRehearsalDatabaseUrl(unsafe), /REHEARSAL_DATABASE_NOT_ISOLATED/);
  }
});

test("ephemeral password는 URL encoding하고 newline을 거부한다", () => {
  const url = isolatedRehearsalDatabaseUrl({ host: "localhost", password: "a:b/@c", port: 13306 });
  assert.match(url, /a%3Ab%2F%40c/);
  assert.match(url, /:13306\/backoffice_rehearsal/);
  assert.throws(
    () => isolatedRehearsalDatabaseUrl({ host: "localhost", password: "bad\nvalue" }),
    /REHEARSAL_DATABASE_PASSWORD_INVALID/,
  );
});

test("trigger가 없는 logical dump는 exact source 계약으로만 재구성한다", async () => {
  const client = new FakeTriggerClient([]);
  const evidence = await ensureRestoredAppendOnlyTriggers({
    client,
    databaseUrl: "mysql://root:test@127.0.0.1:3306/backoffice_rehearsal",
    executeTriggerDdl: (statement) => client.executeTriggerDdl(statement),
  });
  assert.deepEqual(evidence, {
    mode: "RECONSTRUCTED_FROM_SOURCE_CONTRACT",
    verified: REQUIRED_APPEND_ONLY_TRIGGERS.length,
    contractDigest: appendOnlyContractDigest(),
  });
  assert.equal(client.statements.length, REQUIRED_APPEND_ONLY_TRIGGERS.length);
});

test("dump가 exact trigger를 보존했으면 DDL을 다시 실행하지 않는다", async () => {
  const client = new FakeTriggerClient(REQUIRED_APPEND_ONLY_TRIGGERS.map((_, index) => observation(index)));
  const evidence = await ensureRestoredAppendOnlyTriggers({
    client,
    databaseUrl: "mysql://root:test@127.0.0.1:3306/backoffice_rehearsal",
    executeTriggerDdl: (statement) => client.executeTriggerDdl(statement),
  });
  assert.equal(evidence.mode, "PRESERVED_FROM_DUMP");
  assert.equal(evidence.verified, REQUIRED_APPEND_ONLY_TRIGGERS.length);
  assert.deepEqual(client.statements, []);
});

test("부분·변형·추가 trigger는 자동 복구하지 않고 실패한다", async () => {
  const partial = new FakeTriggerClient([observation(0)]);
  await assert.rejects(
    () => ensureRestoredAppendOnlyTriggers({
      client: partial,
      databaseUrl: "mysql://root:test@127.0.0.1:3306/backoffice_rehearsal",
      executeTriggerDdl: (statement) => partial.executeTriggerDdl(statement),
    }),
    /missing:/,
  );
  assert.deepEqual(partial.statements, []);

  const mismatch = new FakeTriggerClient([
    { ...observation(0), timing: "AFTER" },
    observation(1),
  ]);
  await assert.rejects(
    () => ensureRestoredAppendOnlyTriggers({
      client: mismatch,
      databaseUrl: "mysql://root:test@127.0.0.1:3306/backoffice_rehearsal",
      executeTriggerDdl: (statement) => mismatch.executeTriggerDdl(statement),
    }),
    /mismatch:/,
  );
  assert.deepEqual(mismatch.statements, []);

  const extra = new FakeTriggerClient([
    observation(0),
    observation(1),
    { ...observation(0), name: "unexpected_trigger" },
  ]);
  await assert.rejects(
    () => ensureRestoredAppendOnlyTriggers({
      client: extra,
      databaseUrl: "mysql://root:test@127.0.0.1:3306/backoffice_rehearsal",
      executeTriggerDdl: (statement) => extra.executeTriggerDdl(statement),
    }),
    /unexpected:/,
  );
  assert.deepEqual(extra.statements, []);
});

test("원격 DB 또는 TRIGGER 가시성 없는 principal에는 DDL을 실행하지 않는다", async () => {
  const remote = new FakeTriggerClient([]);
  await assert.rejects(
    () => ensureRestoredAppendOnlyTriggers({
      client: remote,
      databaseUrl: "mysql://root:test@mysql.data.svc.cluster.local:3306/backoffice_rehearsal",
      executeTriggerDdl: (statement) => remote.executeTriggerDdl(statement),
    }),
    /REHEARSAL_DATABASE_NOT_ISOLATED/,
  );
  assert.deepEqual(remote.statements, []);

  const forbidden = new FakeTriggerClient([], "GRANT SELECT ON `backoffice_rehearsal`.* TO `u`@`%`");
  await assert.rejects(
    () => ensureRestoredAppendOnlyTriggers({
      client: forbidden,
      databaseUrl: "mysql://u:test@127.0.0.1:3306/backoffice_rehearsal",
      executeTriggerDdl: (statement) => forbidden.executeTriggerDdl(statement),
    }),
    /RESTORE_TRIGGER_VISIBILITY_FORBIDDEN/,
  );
  assert.deepEqual(forbidden.statements, []);
});
