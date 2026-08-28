/**
 * 감사 원장 append-only trigger의 repo-local 계약이다.
 *
 * migration SQL은 CI static gate(`scripts/check-migration-safety.mjs`)가 검사하지만,
 * baseline/recovery resolve 경로로 migration row만 성공 처리되면 live DB에 trigger가
 * 없어도 schema fingerprint는 통과한다. 배포 gate가 live readback으로 다시 확인한다.
 */

export type AppendOnlyTriggerEvent = "UPDATE" | "DELETE";

export interface AppendOnlyTriggerRequirement {
  name: string;
  table: string;
  event: AppendOnlyTriggerEvent;
  message: string;
}

export interface ObservedTrigger {
  name: string;
  table: string;
  event: string;
  timing: string;
  statement: string;
}

const PROVIDER_EXECUTION_AUDIT_MESSAGE = "provider execution audit is append-only";

/** live DB에 반드시 존재해야 하는 append-only trigger. migration SQL과 동일해야 한다. */
export const REQUIRED_APPEND_ONLY_TRIGGERS: readonly AppendOnlyTriggerRequirement[] = [
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

const CREATE_TRIGGER_PATTERN =
  /\bCREATE\s+TRIGGER\s+`?([a-z0-9_]+)`?\s+BEFORE\s+(UPDATE|DELETE)\s+ON\s+`?([a-z0-9_]+)`?\s+FOR\s+EACH\s+ROW\s+SIGNAL\s+SQLSTATE\s+'45000'\s+SET\s+MESSAGE_TEXT\s*=\s*'([^']+)'\s*;/gi;

/** MySQL이 information_schema.TRIGGERS에 정규화해 저장하는 본문. */
export function appendOnlyActionStatement(message: string): string {
  return `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${message}'`;
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
      || trigger.statement.trim() !== appendOnlyActionStatement(requirement.message)
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
