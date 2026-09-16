import assert from "node:assert/strict";
import test from "node:test";
import type { OperationalIncident } from "@prisma/client";
import {
  incidentComponents,
  incidentDeliveryMode,
  incidentRender,
} from "@/lib/notifications/incidents";
import { EMBED_COLOR } from "@/lib/notifications/style";

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
  assert.equal(incidentRender(open).embed?.title, "🚨 CPU 임계치 초과");
  assert.equal(incidentRender(open).embed?.color, EMBED_COLOR.FAILURE);
  assert.equal(incidentComponents(open)[0]?.components[0]?.label, "확인");
  assert.deepEqual(incidentDeliveryMode(open.providerMessageId), { kind: "create" });

  const acknowledged = incident({
    status: "ACKNOWLEDGED",
    providerMessageId: "message-1",
    acknowledgedBy: "operator-1",
    assignedDiscordUserId: "operator-1",
  });
  assert.match(incidentRender(acknowledged).text, /상태: \*\*확인됨\*\*/);
  assert.match(incidentRender(acknowledged).text, /<@operator-1>/);
  // 같은 메시지를 편집해 수명주기를 표현하므로 색이 상태를 따라 흐른다.
  assert.equal(incidentRender(acknowledged).embed?.color, EMBED_COLOR.WARNING);
  assert.deepEqual(incidentDeliveryMode(acknowledged.providerMessageId), {
    kind: "edit",
    messageId: "message-1",
  });

  const recovered = incident({ status: "RECOVERED", recoveredAt: new Date("2026-08-18T00:10:00Z") });
  assert.equal(incidentRender(recovered).embed?.title, "✅ CPU 임계치 초과");
  assert.equal(incidentRender(recovered).embed?.color, EMBED_COLOR.SUCCESS);
  assert.deepEqual(incidentComponents(recovered), []);
});
