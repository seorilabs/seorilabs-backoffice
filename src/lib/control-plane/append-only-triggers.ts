/**
 * 감사 원장 append-only trigger의 repo-local 계약이다.
 *
 * migration SQL은 CI static gate(`scripts/check-migration-safety.mjs`)가 검사하지만,
 * baseline/recovery resolve 경로로 migration row만 성공 처리되면 live DB에 trigger가
 * 없어도 schema fingerprint는 통과한다. 배포 gate가 live readback으로 다시 확인한다.
 */

import { createHash } from "node:crypto";

export type AppendOnlyTriggerEvent = "UPDATE" | "DELETE";

export interface AppendOnlyTriggerRequirement {
  name: string;
  table: string;
  event: AppendOnlyTriggerEvent;
  message: string;
}

/**
 * MySQL은 대상 table의 `TRIGGER` 권한이 없는 principal에게
 * `information_schema.TRIGGERS`를 빈 결과로 돌려준다. 권한 부족을 리소스 부재로
 * 읽지 않기 위해 두 상태를 분리한다.
 */
export type TriggerVisibility = "VISIBLE" | "FORBIDDEN";

export interface AppendOnlyTriggerVerification {
  visibility: TriggerVisibility;
  verified: number;
}

export interface ObservedTrigger {
  name: string;
  table: string;
  event: string;
  timing: string;
  statement: string;
}

const PROVIDER_EXECUTION_AUDIT_MESSAGE = "provider execution audit is append-only";
const AUTH_BROKER_JOURNAL_CHECKPOINT_AUDIT_MESSAGE = "auth broker journal checkpoint audit is append-only";
const FLEET_MIGRATION_PROOF_AUDIT_MESSAGE = "fleet migration proof audit is append-only";
const FLEET_MIGRATION_OCCURRENCE_AUDIT_MESSAGE = "fleet migration occurrence audit is append-only";
const FLEET_MIGRATION_COMPLETION_AUDIT_MESSAGE = "fleet migration completion audit is append-only";
const FLEET_MIGRATION_ISSUANCE_AUDIT_MESSAGE = "fleet migration authoritative issuance audit is append-only";
const LEGACY_CONFIG_RESOLUTION_AUDIT_MESSAGE = "legacy config resolution audit is append-only";

const PROVIDER_EXECUTION_APPEND_ONLY_TRIGGERS: readonly AppendOnlyTriggerRequirement[] = [
  {
    name: "control_plane_provider_execution_event_no_delete",
    table: "control_plane_provider_execution_event",
    event: "DELETE",
    message: PROVIDER_EXECUTION_AUDIT_MESSAGE,
  },
  {
    name: "control_plane_provider_execution_event_no_update",
    table: "control_plane_provider_execution_event",
    event: "UPDATE",
    message: PROVIDER_EXECUTION_AUDIT_MESSAGE,
  },
];

/** P2 Auth Broker journal checkpoint 감사 원장의 독립 append-only trigger 계약이다. */
export const AUTH_BROKER_JOURNAL_CHECKPOINT_APPEND_ONLY_TRIGGERS: readonly AppendOnlyTriggerRequirement[] = [
  {
    name: "control_plane_auth_broker_journal_checkpoint_event_no_delete",
    table: "control_plane_auth_broker_journal_checkpoint_event",
    event: "DELETE",
    message: AUTH_BROKER_JOURNAL_CHECKPOINT_AUDIT_MESSAGE,
  },
  {
    name: "control_plane_auth_broker_journal_checkpoint_event_no_update",
    table: "control_plane_auth_broker_journal_checkpoint_event",
    event: "UPDATE",
    message: AUTH_BROKER_JOURNAL_CHECKPOINT_AUDIT_MESSAGE,
  },
];

/** P7 proof, claim, completion, authoritative issuance 원장을 UPDATE/DELETE 없이 고정한다. */
export const FLEET_MIGRATION_APPEND_ONLY_TRIGGERS: readonly AppendOnlyTriggerRequirement[] = [
  {
    name: "control_plane_fleet_migration_proof_snapshot_no_delete",
    table: "control_plane_fleet_migration_proof_snapshot",
    event: "DELETE",
    message: FLEET_MIGRATION_PROOF_AUDIT_MESSAGE,
  },
  {
    name: "control_plane_fleet_migration_proof_snapshot_no_update",
    table: "control_plane_fleet_migration_proof_snapshot",
    event: "UPDATE",
    message: FLEET_MIGRATION_PROOF_AUDIT_MESSAGE,
  },
  {
    name: "control_plane_fleet_migration_collection_occurrence_no_delete",
    table: "control_plane_fleet_migration_collection_occurrence",
    event: "DELETE",
    message: FLEET_MIGRATION_OCCURRENCE_AUDIT_MESSAGE,
  },
  {
    name: "control_plane_fleet_migration_collection_occurrence_no_update",
    table: "control_plane_fleet_migration_collection_occurrence",
    event: "UPDATE",
    message: FLEET_MIGRATION_OCCURRENCE_AUDIT_MESSAGE,
  },
  {
    name: "control_plane_fleet_migration_collection_completion_no_delete",
    table: "control_plane_fleet_migration_collection_completion",
    event: "DELETE",
    message: FLEET_MIGRATION_COMPLETION_AUDIT_MESSAGE,
  },
  {
    name: "control_plane_fleet_migration_collection_completion_no_update",
    table: "control_plane_fleet_migration_collection_completion",
    event: "UPDATE",
    message: FLEET_MIGRATION_COMPLETION_AUDIT_MESSAGE,
  },
  {
    name: "control_plane_fleet_migration_authoritative_issuance_no_delete",
    table: "control_plane_fleet_migration_authoritative_issuance",
    event: "DELETE",
    message: FLEET_MIGRATION_ISSUANCE_AUDIT_MESSAGE,
  },
  {
    name: "control_plane_fleet_migration_authoritative_issuance_no_update",
    table: "control_plane_fleet_migration_authoritative_issuance",
    event: "UPDATE",
    message: FLEET_MIGRATION_ISSUANCE_AUDIT_MESSAGE,
  },
];

/** 중앙 상태 대체에 대한 사람/자동화 승인은 새 revision만 추가할 수 있다. */
export const LEGACY_CONFIG_RESOLUTION_APPEND_ONLY_TRIGGERS: readonly AppendOnlyTriggerRequirement[] = [
  {
    name: "control_plane_legacy_config_resolution_no_delete",
    table: "control_plane_legacy_config_resolution",
    event: "DELETE",
    message: LEGACY_CONFIG_RESOLUTION_AUDIT_MESSAGE,
  },
  {
    name: "control_plane_legacy_config_resolution_no_update",
    table: "control_plane_legacy_config_resolution",
    event: "UPDATE",
    message: LEGACY_CONFIG_RESOLUTION_AUDIT_MESSAGE,
  },
];

/** 일반 migration principal 대신 trusted operator가 설치하는 trigger 계약이다. */
export const TRUSTED_OPERATOR_APPEND_ONLY_TRIGGERS: readonly AppendOnlyTriggerRequirement[] = [
  ...FLEET_MIGRATION_APPEND_ONLY_TRIGGERS,
  ...LEGACY_CONFIG_RESOLUTION_APPEND_ONLY_TRIGGERS,
].sort((left, right) => left.name.localeCompare(right.name));

/**
 * live DB에 반드시 존재하고 고정 in-cluster verifier가 관측하는 전체 계약이다.
 * migration SQL, restore rehearsal, verifier manifest와 digest가 모두 같아야 한다.
 */
export const REQUIRED_APPEND_ONLY_TRIGGERS: readonly AppendOnlyTriggerRequirement[] = [
  ...PROVIDER_EXECUTION_APPEND_ONLY_TRIGGERS,
  ...AUTH_BROKER_JOURNAL_CHECKPOINT_APPEND_ONLY_TRIGGERS,
  ...FLEET_MIGRATION_APPEND_ONLY_TRIGGERS,
  ...LEGACY_CONFIG_RESOLUTION_APPEND_ONLY_TRIGGERS,
].sort((left, right) => left.name.localeCompare(right.name));

const CREATE_TRIGGER_PATTERN =
  /\bCREATE\s+TRIGGER\s+`?([a-z0-9_]+)`?\s+BEFORE\s+(UPDATE|DELETE)\s+ON\s+`?([a-z0-9_]+)`?\s+FOR\s+EACH\s+ROW\s+SIGNAL\s+SQLSTATE\s+'45000'\s+SET\s+MESSAGE_TEXT\s*=\s*'([^']+)'\s*;/gi;

/** MySQL이 information_schema.TRIGGERS에 저장하는 본문. */
export function appendOnlyActionStatement(message: string): string {
  return `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${message}'`;
}

/**
 * restore rehearsal의 격리 DB에서만 쓰는 canonical DDL이다. identifier와 message는
 * repo-local 계약 상수에서 오지만, SQL 문자열을 만들기 전에 다시 제한해 계약 변경이
 * 임의 SQL 실행 경로로 넓어지지 않게 한다.
 */
export function appendOnlyCreateTriggerStatement(
  requirement: AppendOnlyTriggerRequirement,
): string {
  if (
    !/^[a-z0-9_]+$/.test(requirement.name)
    || !/^[a-z0-9_]+$/.test(requirement.table)
    || !new Set<AppendOnlyTriggerEvent>(["UPDATE", "DELETE"]).has(requirement.event)
    || !requirement.message
    || /['\r\n\0]/.test(requirement.message)
  ) {
    throw new Error("APPEND_ONLY_TRIGGER_REQUIREMENT_UNSAFE");
  }
  return [
    `CREATE TRIGGER \`${requirement.name}\``,
    `BEFORE ${requirement.event} ON \`${requirement.table}\``,
    `FOR EACH ROW ${appendOnlyActionStatement(requirement.message)}`,
  ].join(" ");
}

/**
 * MySQL은 client가 보낸 statement를 그대로 보관해 trailing `;`와 공백이 남을 수 있다.
 * 같은 DDL이 설치 경로에 따라 다르게 저장되므로 비교 전에 그 부분만 없앤다.
 */
export function normalizeActionStatement(statement: string): string {
  return statement.trim().replace(/;+$/, "").trim();
}

/** migration SQL에서 선언된 append-only trigger를 이름 순으로 추출한다. */
export function parseAppendOnlyTriggers(sql: string): AppendOnlyTriggerRequirement[] {
  const found: AppendOnlyTriggerRequirement[] = [];
  for (const match of sql.matchAll(CREATE_TRIGGER_PATTERN)) {
    found.push({
      name: match[1],
      event: match[2].toUpperCase() as AppendOnlyTriggerEvent,
      table: match[3],
      message: match[4],
    });
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * live readback이 계약과 정확히 같은지 확인한다.
 *
 * - 필수 trigger 누락, timing/event/table/본문 변형은 모두 실패다.
 * - 보호 대상 table에 계약 밖 trigger가 추가되어도 실패한다. 우회 trigger를 허용하지 않는다.
 */
const GRANT_PATTERN = /^GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\s/i;

function unquoteIdentifier(value: string): string {
  return value.replace(/^[`'"]|[`'"]$/g, "");
}

/**
 * `SHOW GRANTS FOR CURRENT_USER()` 결과에서 보호 table의 trigger를 볼 수 있는지 판정한다.
 * schema 전체 또는 보호 table 전부를 덮는 `TRIGGER`/`ALL PRIVILEGES`만 VISIBLE이다.
 */
export function triggerVisibilityFromGrants(
  grants: readonly string[],
  schema: string,
  required: readonly AppendOnlyTriggerRequirement[] = REQUIRED_APPEND_ONLY_TRIGGERS,
): TriggerVisibility {
  const protectedTables = new Set(required.map((requirement) => requirement.table));
  const covered = new Set<string>();

  for (const grant of grants) {
    const match = GRANT_PATTERN.exec(grant.trim());
    if (!match) continue;
    const privileges = new Set(
      match[1].split(",").map((privilege) => privilege.trim().toUpperCase()),
    );
    if (!privileges.has("TRIGGER") && !privileges.has("ALL PRIVILEGES")) continue;

    const [rawSchema, rawTable] = match[2].split(".");
    if (rawSchema === undefined || rawTable === undefined) continue;
    const grantSchema = unquoteIdentifier(rawSchema);
    const grantTable = unquoteIdentifier(rawTable);
    if (grantSchema !== "*" && grantSchema !== schema) continue;

    if (grantTable === "*") return "VISIBLE";
    if (protectedTables.has(grantTable)) covered.add(grantTable);
  }

  return covered.size === protectedTables.size && protectedTables.size > 0
    ? "VISIBLE"
    : "FORBIDDEN";
}

export function verifyAppendOnlyTriggers(
  observed: readonly ObservedTrigger[],
  required: readonly AppendOnlyTriggerRequirement[] = REQUIRED_APPEND_ONLY_TRIGGERS,
): number {
  const byName = new Map(observed.map((trigger) => [trigger.name, trigger]));
  const problems: string[] = [];

  for (const requirement of required) {
    const trigger = byName.get(requirement.name);
    if (!trigger) {
      problems.push(`missing:${requirement.name}`);
      continue;
    }
    if (
      trigger.table !== requirement.table
      || trigger.event.toUpperCase() !== requirement.event
      || trigger.timing.toUpperCase() !== "BEFORE"
      || normalizeActionStatement(trigger.statement) !== appendOnlyActionStatement(requirement.message)
    ) {
      problems.push(`mismatch:${requirement.name}`);
    }
  }

  const protectedTables = new Set(required.map((requirement) => requirement.table));
  const requiredNames = new Set(required.map((requirement) => requirement.name));
  for (const trigger of observed) {
    if (protectedTables.has(trigger.table) && !requiredNames.has(trigger.name)) {
      problems.push(`unexpected:${trigger.name}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`append-only trigger 계약 실패: ${problems.sort().join(" ")}`);
  }
  return required.length;
}

/**
 * 배포 gate 판정. 관측 principal이 trigger를 볼 수 없으면 부재로 단정하지 않고
 * `FORBIDDEN`으로 남긴다. 이 경우 trigger 설치·검증은 DEPLOY.md의 trusted operator
 * 복구 Job이 담당한다.
 */
export function evaluateAppendOnlyTriggers(input: {
  visibility: TriggerVisibility;
  observed: readonly ObservedTrigger[];
  required?: readonly AppendOnlyTriggerRequirement[];
}): AppendOnlyTriggerVerification {
  if (input.visibility === "FORBIDDEN") {
    return { visibility: "FORBIDDEN", verified: 0 };
  }
  return {
    visibility: "VISIBLE",
    verified: verifyAppendOnlyTriggers(input.observed, input.required),
  };
}

/**
 * 계약의 canonical digest. 고정 in-cluster verifier가 자기 manifest에 구운 같은 값을
 * 관측 결과에 함께 기록하고, 배포 script가 repo 값과 대조한다. verifier가 옛 계약으로
 * 남아 있으면 digest가 달라 배포가 fail-closed한다.
 */
export function appendOnlyContractDigest(
  required: readonly AppendOnlyTriggerRequirement[] = REQUIRED_APPEND_ONLY_TRIGGERS,
): string {
  const canonical = [...required]
    .map((requirement) => ({
      event: requirement.event,
      message: requirement.message,
      name: requirement.name,
      table: requirement.table,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
