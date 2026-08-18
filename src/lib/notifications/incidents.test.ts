import assert from "node:assert/strict";
import test from "node:test";
import type { OperationalIncident } from "@prisma/client";
import {
  incidentComponents,
  incidentDeliveryMode,
  incidentMessage,
} from "@/lib/notifications/incidents";

function incident(overrides: Partial<OperationalIncident> = {}): OperationalIncident {
  const detectedAt = new Date("2026-08-18T00:00:00Z");
  return {
    id: "incident-1",
    dedupeKey: "grafana:cpu:global:1",
    appId: null,
    source: "grafana",
    kind: "cpu",
    severity: "critical",
    status: "OPEN",
    summary: "CPU 임계치 초과",
    evidence: null,
    destinationKey: "ops-alerts",
    providerMessageId: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
    assignedDiscordUserId: null,
    firstDetectedAt: detectedAt,
    lastDetectedAt: detectedAt,
    recoveredAt: null,
    createdAt: detectedAt,
    updatedAt: detectedAt,
    ...overrides,
  };
}

test("장애 발생·확인·복구 상태를 같은 카드 수명주기로 표시한다", () => {
  const open = incident();
  assert.match(incidentMessage(open), /🚨.*CPU 임계치 초과/);
  assert.equal(incidentComponents(open)[0]?.components[0]?.label, "확인");
  assert.deepEqual(incidentDeliveryMode(open.providerMessageId), { kind: "create" });

  const acknowledged = incident({
    status: "ACKNOWLEDGED",
    providerMessageId: "message-1",
    acknowledgedBy: "operator-1",
    assignedDiscordUserId: "operator-1",
  });
  assert.match(incidentMessage(acknowledged), /상태: \*\*확인됨\*\*/);
  assert.match(incidentMessage(acknowledged), /<@operator-1>/);
  assert.deepEqual(incidentDeliveryMode(acknowledged.providerMessageId), {
    kind: "edit",
    messageId: "message-1",
  });

  const recovered = incident({ status: "RECOVERED", recoveredAt: new Date("2026-08-18T00:10:00Z") });
  assert.match(incidentMessage(recovered), /✅.*CPU 임계치 초과/);
  assert.deepEqual(incidentComponents(recovered), []);
});
