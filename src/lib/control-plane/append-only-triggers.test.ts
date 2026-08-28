import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  REQUIRED_APPEND_ONLY_TRIGGERS,
  appendOnlyActionStatement,
  parseAppendOnlyTriggers,
  evaluateAppendOnlyTriggers,
  triggerVisibilityFromGrants,
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
  assert.match(script, /evaluateAppendOnlyTriggers/);
  assert.match(script, /appendOnlyTriggers=\$\{appendOnlyTriggers\}/);
});

test("TRIGGER 권한이 없는 principal은 FORBIDDEN이다", () => {
  // production `backoffice`@`%`의 실제 SHOW GRANTS 출력이다.
  const grants = [
    "GRANT USAGE ON *.* TO `backoffice`@`%`",
    "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER ON `backoffice`.* TO `backoffice`@`%`",
  ];
  assert.equal(triggerVisibilityFromGrants(grants, "backoffice"), "FORBIDDEN");
});

test("schema 또는 전역 TRIGGER 권한은 VISIBLE이다", () => {
  assert.equal(
    triggerVisibilityFromGrants(["GRANT SELECT, TRIGGER ON `backoffice`.* TO `u`@`%`"], "backoffice"),
    "VISIBLE",
  );
  assert.equal(
    triggerVisibilityFromGrants(["GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` WITH GRANT OPTION"], "backoffice"),
    "VISIBLE",
  );
  assert.equal(
    triggerVisibilityFromGrants(["GRANT TRIGGER ON `other`.* TO `u`@`%`"], "backoffice"),
    "FORBIDDEN",
  );
});

test("보호 table 전부에 table 단위 TRIGGER 권한이 있어야 VISIBLE이다", () => {
  const table = REQUIRED_APPEND_ONLY_TRIGGERS[0].table;
  const partial = [`GRANT TRIGGER ON \`backoffice\`.\`${table}\` TO \`u\`@\`%\``];
  assert.equal(triggerVisibilityFromGrants(partial, "backoffice"), "VISIBLE");
  assert.equal(
    triggerVisibilityFromGrants(
      [`GRANT TRIGGER ON \`backoffice\`.\`unrelated\` TO \`u\`@\`%\``],
      "backoffice",
    ),
    "FORBIDDEN",
  );
});

test("FORBIDDEN은 부재로 단정하지 않고 배포를 막지 않는다", () => {
  assert.deepEqual(
    evaluateAppendOnlyTriggers({ visibility: "FORBIDDEN", observed: [] }),
    { visibility: "FORBIDDEN", verified: 0 },
  );
});

test("VISIBLE에서는 기존 fail-closed 계약이 그대로 적용된다", () => {
  assert.deepEqual(
    evaluateAppendOnlyTriggers({ visibility: "VISIBLE", observed: compliantObservation() }),
    { visibility: "VISIBLE", verified: REQUIRED_APPEND_ONLY_TRIGGERS.length },
  );
  assert.throws(
    () => evaluateAppendOnlyTriggers({ visibility: "VISIBLE", observed: [] }),
    /missing:/,
  );
});

test("배포 gate script는 권한을 먼저 읽고 FORBIDDEN을 구분해 출력한다", () => {
  const script = readFileSync(join(process.cwd(), "scripts/verify-migration-state.ts"), "utf8");
  assert.match(script, /SHOW GRANTS FOR CURRENT_USER\(\)/);
  assert.match(script, /triggerVisibilityFromGrants/);
  assert.match(script, /evaluateAppendOnlyTriggers/);
  assert.match(script, /FORBIDDEN\(migration principal에 TRIGGER 권한 없음/);
});

test("trusted verify Job은 계약과 같은 trigger를 read-only로만 확인한다", () => {
  const manifest = readFileSync(
    join(process.cwd(), "k8s/provider-audit-trigger-verify-job.yaml"),
    "utf8",
  );
  for (const requirement of REQUIRED_APPEND_ONLY_TRIGGERS) {
    assert.ok(manifest.includes(requirement.name), `${requirement.name} 미검증`);
    assert.ok(manifest.includes(`EVENT_MANIPULATION='${requirement.event}'`));
    assert.ok(manifest.includes(requirement.table));
  }
  assert.ok(manifest.includes(appendOnlyActionStatement(REQUIRED_APPEND_ONLY_TRIGGERS[0].message)));
  assert.match(manifest, /ACTION_TIMING='BEFORE'/);
  // 우회 trigger 차단: 보호 table 위 전체 개수도 확인한다.
  assert.match(manifest, /total.*!=.*"2".*\|\|.*exact.*!=.*"2"|\[ "\$total" != "2" \]/);
  // DDL·권한 변경·데이터 변경이 없어야 한다.
  assert.doesNotMatch(manifest, /CREATE TRIGGER|DROP TRIGGER|GRANT |REVOKE |ALTER TABLE|DELETE FROM|INSERT INTO/);
  assert.match(manifest, /namespace: data/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
});

test("배포 script는 trigger verify Job 성공을 rollout 선행조건으로 둔다", () => {
  const deploy = readFileSync(join(process.cwd(), "scripts/deploy-backoffice.sh"), "utf8");
  const verifyIndex = deploy.indexOf("provider-audit-trigger-verify-job.yaml");
  const rolloutIndex = deploy.indexOf("availability-preserving web rollout");
  assert.ok(verifyIndex > 0, "verify Job 생성이 없다");
  assert.ok(verifyIndex < rolloutIndex, "verify가 rollout 뒤에 있다");
  assert.match(deploy, /wait_for_job trigger-verify/);
  assert.match(deploy, /verify_job_sha" != "\$source_sha"/);
  assert.match(deploy, /audit_namespace/);
});
