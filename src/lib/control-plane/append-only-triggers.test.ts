import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  REQUIRED_APPEND_ONLY_TRIGGERS,
  appendOnlyActionStatement,
  parseAppendOnlyTriggers,
  verifyAppendOnlyTriggers,
  type ObservedTrigger,
} from "@/lib/control-plane/append-only-triggers";

const migrationsRoot = join(process.cwd(), "prisma/migrations");

function observed(
  overrides: Partial<ObservedTrigger> & Pick<ObservedTrigger, "name">,
): ObservedTrigger {
  const requirement = REQUIRED_APPEND_ONLY_TRIGGERS.find((entry) => entry.name === overrides.name);
  return {
    name: overrides.name,
    table: overrides.table ?? requirement?.table ?? "unknown_table",
    event: overrides.event ?? requirement?.event ?? "UPDATE",
    timing: overrides.timing ?? "BEFORE",
    statement: overrides.statement
      ?? appendOnlyActionStatement(requirement?.message ?? "append-only"),
  };
}

function compliantObservation(): ObservedTrigger[] {
  return REQUIRED_APPEND_ONLY_TRIGGERS.map((requirement) => observed({ name: requirement.name }));
}

test("required trigger 계약은 migration SQL 선언과 정확히 같다", () => {
  const declared = readdirSync(migrationsRoot)
    .sort()
    .flatMap((name) => {
      const sqlPath = join(migrationsRoot, name, "migration.sql");
      let sql: string;
      try {
        sql = readFileSync(sqlPath, "utf8");
      } catch {
        return [];
      }
      return parseAppendOnlyTriggers(sql);
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  assert.deepEqual(declared, [...REQUIRED_APPEND_ONLY_TRIGGERS]);
  assert.ok(declared.length > 0);
});

test("계약과 동일한 live readback만 통과한다", () => {
  assert.equal(
    verifyAppendOnlyTriggers(compliantObservation()),
    REQUIRED_APPEND_ONLY_TRIGGERS.length,
  );
});

test("trigger가 없으면 배포 gate가 fail-closed한다", () => {
  assert.throws(
    () => verifyAppendOnlyTriggers([]),
    /append-only trigger 계약 실패: .*missing:control_plane_provider_execution_event_no_delete/,
  );
  const partial = compliantObservation().slice(1);
  assert.throws(() => verifyAppendOnlyTriggers(partial), /missing:/);
});

test("MySQL이 보관한 trailing 세미콜론 차이는 계약 위반이 아니다", () => {
  // MySQL 9.2는 client가 보낸 statement를 그대로 저장해 같은 migration에서도
  // trigger마다 trailing `;` 유무가 갈린다. prisma migrate deploy 뒤 실측한 형태다.
  const observation = REQUIRED_APPEND_ONLY_TRIGGERS.map((requirement, index) => observed({
    name: requirement.name,
    statement: index === 0
      ? `${appendOnlyActionStatement(requirement.message)};`
      : `  ${appendOnlyActionStatement(requirement.message)}  `,
  }));
  assert.equal(verifyAppendOnlyTriggers(observation), REQUIRED_APPEND_ONLY_TRIGGERS.length);
});

test("timing·event·table·본문 변형은 통과하지 않는다", () => {
  const [first, ...rest] = compliantObservation();
  assert.throws(
    () => verifyAppendOnlyTriggers([{ ...first, timing: "AFTER" }, ...rest]),
    new RegExp(`mismatch:${first.name}`),
  );
  assert.throws(
    () => verifyAppendOnlyTriggers([{ ...first, table: "other_table" }, ...rest]),
    /mismatch:|missing:/,
  );
  assert.throws(
    () => verifyAppendOnlyTriggers([
      { ...first, statement: "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'weakened'" },
      ...rest,
    ]),
    new RegExp(`mismatch:${first.name}`),
  );
});

test("보호 table의 계약 밖 trigger는 우회로 취급한다", () => {
  const extra = observed({
    name: "control_plane_provider_execution_event_bypass",
    table: REQUIRED_APPEND_ONLY_TRIGGERS[0].table,
    event: "UPDATE",
    statement: appendOnlyActionStatement(REQUIRED_APPEND_ONLY_TRIGGERS[0].message),
  });
  assert.throws(
    () => verifyAppendOnlyTriggers([...compliantObservation(), extra]),
    /unexpected:control_plane_provider_execution_event_bypass/,
  );
});

test("보호 대상이 아닌 table의 trigger는 무시한다", () => {
  const unrelated: ObservedTrigger = {
    name: "unrelated_no_update",
    table: "unrelated_table",
    event: "UPDATE",
    timing: "BEFORE",
    statement: appendOnlyActionStatement("unrelated"),
  };
  assert.equal(
    verifyAppendOnlyTriggers([...compliantObservation(), unrelated]),
    REQUIRED_APPEND_ONLY_TRIGGERS.length,
  );
});

test("배포 gate script가 live trigger readback을 수행한다", () => {
  const script = readFileSync(join(process.cwd(), "scripts/verify-migration-state.ts"), "utf8");
  assert.match(script, /information_schema\.TRIGGERS/);
  assert.match(script, /verifyAppendOnlyTriggers/);
  assert.match(script, /appendOnlyTriggers=\$\{appendOnlyTriggers\}/);
});
