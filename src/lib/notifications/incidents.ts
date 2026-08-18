import { Prisma, type OperationalIncident } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { configuredDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import type { DiscordActionRow } from "@/lib/notifications/discord";

export function incidentComponents(incident: Pick<OperationalIncident, "id" | "status" | "assignedDiscordUserId">): DiscordActionRow[] {
  if (incident.status === "RECOVERED") return [];
  return [{
    type: 1,
    components: [
      { type: 2, style: 2, label: incident.status === "OPEN" ? "확인" : "확인됨", custom_id: `incident:ack:${incident.id}`, disabled: incident.status !== "OPEN" },
      { type: 2, style: 1, label: incident.assignedDiscordUserId ? "담당 지정됨" : "내가 담당", custom_id: `incident:assign:${incident.id}`, disabled: Boolean(incident.assignedDiscordUserId) },
    ],
  }];
}

export function incidentMessage(incident: OperationalIncident): string {
  const icon = incident.status === "RECOVERED" ? "✅" : incident.severity === "critical" ? "🚨" : "⚠️";
  const state = incident.status === "OPEN" ? "발생" : incident.status === "ACKNOWLEDGED" ? "확인됨" : "복구";
  const lines = [
    `${icon} **${incident.summary}**`,
    `상태: **${state}** · 최초 ${incident.firstDetectedAt.toISOString()} · 최근 ${incident.lastDetectedAt.toISOString()}`,
  ];
  if (incident.acknowledgedBy) lines.push(`확인: <@${incident.acknowledgedBy}>`);
  if (incident.assignedDiscordUserId) lines.push(`담당: <@${incident.assignedDiscordUserId}>`);
  if (incident.recoveredAt) lines.push(`복구 시각: ${incident.recoveredAt.toISOString()}`);
  return lines.join("\n");
}

export function incidentDeliveryMode(providerMessageId: string | null):
  | { kind: "edit"; messageId: string }
  | { kind: "create" } {
  return providerMessageId
    ? { kind: "edit", messageId: providerMessageId }
    : { kind: "create" };
}

async function enqueueIncident(incident: OperationalIncident, signalId: string): Promise<void> {
  await enqueueNotification({
    dedupeKey: `incident:${incident.id}:${signalId}`,
    kind: "INCIDENT",
    payload: { incidentId: incident.id },
    occurredAt: incident.lastDetectedAt,
    destinations: configuredDestinations([incident.destinationKey === "ops-alerts" ? "ops-alerts" : "metrics-daily"]),
  });
}

export async function recordIncident(input: {
  source: string;
  kind: string;
  severity: "warning" | "critical";
  summary: string;
  signalId: string;
  detectedAt: Date;
  appId?: string;
  evidence?: Prisma.InputJsonObject;
  destinationKey?: "ops-alerts" | "metrics-daily";
}): Promise<OperationalIncident> {
  const existing = await prisma.operationalIncident.findFirst({
    where: {
      source: input.source,
      kind: input.kind,
      appId: input.appId ?? null,
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
    },
    orderBy: { firstDetectedAt: "desc" },
  });
  const incident = existing
    ? await prisma.operationalIncident.update({
        where: { id: existing.id },
        data: {
          severity: input.severity,
          summary: input.summary,
          evidence: input.evidence,
          lastDetectedAt: input.detectedAt,
        },
      })
    : await prisma.operationalIncident.create({
        data: {
          dedupeKey: `${input.source}:${input.kind}:${input.appId ?? "global"}:${input.signalId}`,
          appId: input.appId,
          source: input.source,
          kind: input.kind,
          severity: input.severity,
          summary: input.summary,
          evidence: input.evidence,
          destinationKey: input.destinationKey ?? "ops-alerts",
          firstDetectedAt: input.detectedAt,
          lastDetectedAt: input.detectedAt,
        },
      });
  await enqueueIncident(incident, input.signalId);
  return incident;
}

export async function recoverIncident(input: {
  source: string;
  kind: string;
  appId?: string;
  signalId: string;
  recoveredAt: Date;
}): Promise<OperationalIncident | null> {
  const active = await prisma.operationalIncident.findFirst({
    where: { source: input.source, kind: input.kind, appId: input.appId ?? null, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    orderBy: { firstDetectedAt: "desc" },
  });
  if (!active) return null;
  const incident = await prisma.operationalIncident.update({
    where: { id: active.id },
    data: { status: "RECOVERED", recoveredAt: input.recoveredAt, lastDetectedAt: input.recoveredAt },
  });
  await enqueueIncident(incident, input.signalId);
  return incident;
}

export async function acknowledgeIncident(id: string, actorDiscordUserId: string, assignSelf: boolean) {
  const incident = await prisma.operationalIncident.findUnique({ where: { id } });
  if (!incident) throw new Error("장애를 찾을 수 없습니다.");
  if (incident.status === "RECOVERED") return incident;
  return prisma.operationalIncident.update({
    where: { id },
    data: {
      status: "ACKNOWLEDGED",
      acknowledgedBy: incident.acknowledgedBy ?? actorDiscordUserId,
      acknowledgedAt: incident.acknowledgedAt ?? new Date(),
      ...(assignSelf ? { assignedDiscordUserId: actorDiscordUserId } : {}),
    },
  });
}
