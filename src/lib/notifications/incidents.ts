import { Prisma, type OperationalIncident } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { kstDateTime } from "@/lib/format/kst";
import { EMBED_COLOR } from "@/lib/notifications/style";
import type { DiscordRender } from "@/lib/notifications/format";
import { discordDestinations, isDiscordDestinationKey } from "@/lib/notifications/destinations";
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

/**
 * 장애 카드.
 *
 * 이 카드는 같은 메시지를 편집해 수명주기를 표현한다. 그래서 상태별 색을 따로 만들지
 * 않고 결과 색을 그대로 태운다 — 발생(빨강)에서 확인됨(주황)을 거쳐 복구(초록)로
 * 흘러가는 편이, 고정된 "장애색" 하나보다 지금 상태를 정확히 전달한다.
 */
export function incidentRender(incident: OperationalIncident): DiscordRender {
  const icon = incident.status === "RECOVERED" ? "✅" : incident.severity === "critical" ? "🚨" : "⚠️";
  const state = incident.status === "OPEN" ? "발생" : incident.status === "ACKNOWLEDGED" ? "확인됨" : "복구";
  const color = incident.status === "RECOVERED"
    ? EMBED_COLOR.SUCCESS
    : incident.status === "ACKNOWLEDGED" || incident.severity !== "critical"
      ? EMBED_COLOR.WARNING
      : EMBED_COLOR.FAILURE;
  const lines = [`상태: **${state}** · 최초 ${kstDateTime(incident.firstDetectedAt)}`];
  if (incident.acknowledgedBy) lines.push(`확인: <@${incident.acknowledgedBy}>`);
  if (incident.assignedDiscordUserId) lines.push(`담당: <@${incident.assignedDiscordUserId}>`);
  if (incident.recoveredAt) lines.push(`복구 시각: ${kstDateTime(incident.recoveredAt)}`);
  return {
    text: lines.join("\n"),
    embed: {
      title: `${icon} ${incident.summary}`,
      color,
      // 최근 관측은 상자 하단에 맡긴다. 이 카드는 신호가 올 때마다 편집되므로
      // "마지막으로 언제 관측됐나" 가 늘 필요하다.
      timestamp: incident.lastDetectedAt.toISOString(),
    },
  };
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
    // 목적지는 장애가 만들어질 때 고정된 값을 그대로 쓴다. 살아 있는 카드를
    // 중간에 다른 채널로 옮기면 그 카드의 수명주기 편집이 끊긴다.
    destinations: discordDestinations([
      isDiscordDestinationKey(incident.destinationKey) ? incident.destinationKey : "ops-alerts",
    ]),
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
