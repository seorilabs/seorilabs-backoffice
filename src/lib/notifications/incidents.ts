import { Prisma, type OperationalIncident } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { kstDateTime } from "@/lib/format/kst";
import { EMBED_COLOR } from "@/lib/notifications/style";
import type { DiscordRender } from "@/lib/notifications/format";
import {
  discordDestinations,
  isDiscordDestinationKey,
} from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import type { DiscordActionRow } from "@/lib/notifications/discord";

export function incidentComponents(
  incident: Pick<
    OperationalIncident,
    "id" | "status" | "assignedDiscordUserId"
  >,
): DiscordActionRow[] {
  if (incident.status === "RECOVERED") return [];
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: incident.status === "OPEN" ? "확인" : "확인됨",
          custom_id: `incident:ack:${incident.id}`,
          disabled: incident.status !== "OPEN",
        },
        {
          type: 2,
          style: 1,
          label: incident.assignedDiscordUserId ? "담당 지정됨" : "내가 담당",
          custom_id: `incident:assign:${incident.id}`,
          disabled: Boolean(incident.assignedDiscordUserId),
        },
        {
          type: 2,
          style: 3,
          label: "해결 처리",
          custom_id: `incident:resolve:${incident.id}`,
        },
      ],
    },
  ];
}

/**
 * 장애 카드.
 *
 * 이 카드는 같은 메시지를 편집해 수명주기를 표현한다. 그래서 상태별 색을 따로 만들지
 * 않고 결과 색을 그대로 태운다 — 발생(빨강)에서 확인됨(주황)을 거쳐 복구(초록)로
 * 흘러가는 편이, 고정된 "장애색" 하나보다 지금 상태를 정확히 전달한다.
 */
export function incidentRender(incident: OperationalIncident): DiscordRender {
  const icon =
    incident.status === "RECOVERED"
      ? "✅"
      : incident.severity === "critical"
        ? "🚨"
        : "⚠️";
  const state =
    incident.status === "OPEN"
      ? "발생"
      : incident.status === "ACKNOWLEDGED"
        ? "확인됨"
        : incident.evidence &&
            typeof incident.evidence === "object" &&
            !Array.isArray(incident.evidence) &&
            incident.evidence.resolutionSource === "operator"
          ? "운영자 해결 처리"
          : "복구";
  const color =
    incident.status === "RECOVERED"
      ? EMBED_COLOR.SUCCESS
      : incident.status === "ACKNOWLEDGED" || incident.severity !== "critical"
        ? EMBED_COLOR.WARNING
        : EMBED_COLOR.FAILURE;
  const evidence =
    incident.evidence &&
    typeof incident.evidence === "object" &&
    !Array.isArray(incident.evidence)
      ? (incident.evidence as Prisma.JsonObject)
      : {};
  const lines = [
    `상태: **${state}** · 최초 ${kstDateTime(incident.firstDetectedAt)}`,
  ];
  if (incident.source === "metrics")
    lines.push("지표 이상입니다. 서비스 이용 불가가 확인된 것은 아닙니다.");
  if (evidence.impact) lines.push(`영향: ${String(evidence.impact)}`);
  if (evidence.action && incident.status !== "RECOVERED")
    lines.push(`조치: ${String(evidence.action)}`);
  const labels: Record<string, string> = {
    latestDau: "최근 활성 사용자",
    baselineMedianDau: "기준 활성 사용자",
    dropPct: "감소율",
    adCompletions: "광고 완료",
    networkAdImpressions: "광고 노출",
    platform: "마켓·광고 서비스",
    purchaseEnvironment: "주문 환경",
    outcome: "처리 결과",
    resolvedBy: "해결 처리자",
  };
  const facts = Object.entries(evidence)
    .filter(
      ([key, value]) =>
        !["impact", "action", "eventType", "resolutionSource"].includes(key) &&
        ["string", "number", "boolean"].includes(typeof value),
    )
    .slice(0, 6);
  if (facts.length)
    lines.push(
      "근거: " +
        facts
          .map(
            ([key, value]) =>
              `${labels[key] ?? key} ${key === "resolvedBy" ? `<@${String(value)}>` : String(value)}`,
          )
          .join(" · "),
    );
  if (incident.acknowledgedBy)
    lines.push(`확인: <@${incident.acknowledgedBy}>`);
  if (incident.assignedDiscordUserId)
    lines.push(`담당: <@${incident.assignedDiscordUserId}>`);
  if (incident.recoveredAt)
    lines.push(`복구 시각: ${kstDateTime(incident.recoveredAt)}`);
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

export function incidentDeliveryMode(
  providerMessageId: string | null,
): { kind: "edit"; messageId: string } | { kind: "create" } {
  return providerMessageId
    ? { kind: "edit", messageId: providerMessageId }
    : { kind: "create" };
}

async function enqueueIncident(
  incident: OperationalIncident,
  signalId: string,
  db: Pick<Prisma.TransactionClient, "notificationEvent"> = prisma,
): Promise<void> {
  await enqueueNotification(
    {
      dedupeKey: `incident:${incident.id}:${signalId}`,
      kind: "INCIDENT",
      payload: { incidentId: incident.id },
      occurredAt: incident.lastDetectedAt,
      // 목적지는 장애가 만들어질 때 고정된 값을 그대로 쓴다. 살아 있는 카드를
      // 중간에 다른 채널로 옮기면 그 카드의 수명주기 편집이 끊긴다.
      destinations: discordDestinations([
        isDiscordDestinationKey(incident.destinationKey)
          ? incident.destinationKey
          : "ops-alerts",
      ]),
    },
    db,
  );
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
}, transaction?: Prisma.TransactionClient): Promise<OperationalIncident> {
  const dedupeKey = `${input.source}:${input.kind}:${input.appId ?? "global"}:${input.signalId}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const write = async (tx: Prisma.TransactionClient) => {
          const signalKey = `incident-observation:${input.source}:${input.kind}:${input.appId ?? "global"}:${input.signalId}`;
          const recorded = await tx.notificationEvent.findUnique({
            where: { dedupeKey: signalKey },
            select: { payload: true },
          });
          const recordedId = (
            recorded?.payload as { incidentId?: string } | undefined
          )?.incidentId;
          if (recordedId) {
            const prior = await tx.operationalIncident.findUniqueOrThrow({
              where: { id: recordedId },
            });
            if (prior.status !== "RECOVERED")
              await enqueueIncident(prior, input.signalId, tx);
            return prior;
          }
          const seen = await tx.operationalIncident.findUnique({
            where: { dedupeKey },
          });
          // 이미 해결한 같은 신호의 재전송은 새 사건으로 만들지 않는다.
          if (seen?.status === "RECOVERED") return seen;
          const active =
            seen ??
            (await tx.operationalIncident.findFirst({
              where: {
                source: input.source,
                kind: input.kind,
                appId: input.appId ?? null,
                status: { in: ["OPEN", "ACKNOWLEDGED"] },
              },
              orderBy: { firstDetectedAt: "desc" },
            }));
          let incident: OperationalIncident;
          if (active) {
            const changed = await tx.operationalIncident.updateMany({
              where: {
                id: active.id,
                status: { in: ["OPEN", "ACKNOWLEDGED"] },
              },
              data: {
                severity: input.severity,
                summary: input.summary,
                evidence: input.evidence,
                lastDetectedAt: input.detectedAt,
              },
            });
            if (!changed.count) throw Error("INCIDENT_STATE_CHANGED");
            incident = await tx.operationalIncident.findUniqueOrThrow({
              where: { id: active.id },
            });
          } else
            incident = await tx.operationalIncident.create({
              data: {
                dedupeKey,
                appId: input.appId,
                source: input.source,
                kind: input.kind,
                severity: input.severity,
                summary: input.summary,
                evidence: input.evidence,
                destinationKey:
                  input.source === "metrics" ? "app-ops" : "ops-alerts",
                firstDetectedAt: input.detectedAt,
                lastDetectedAt: input.detectedAt,
              },
            });
          await enqueueNotification(
            {
              dedupeKey: signalKey,
              kind: "OPS_ALERT",
              payload: {
                incidentId: incident.id,
                report: {
                  category: "internal",
                  reason: "INCIDENT_SIGNAL_LEDGER",
                },
              },
              destinations: [],
            },
            tx,
          );
          await enqueueIncident(incident, input.signalId, tx);
          return incident;
        };
      return transaction ? await write(transaction) : await prisma.$transaction(write, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (
        transaction || attempt >= 3 ||
        (!["P2034", "P2002"].includes(
          (error as { code?: string }).code ?? "",
        ) &&
          (error as Error).message !== "INCIDENT_STATE_CHANGED")
      )
        throw error;
    }
  }
}

export async function recoverIncident(input: {
  source: string;
  kind: string;
  appId?: string;
  signalId: string;
  recoveredAt: Date;
}, db: Pick<Prisma.TransactionClient, "operationalIncident" | "notificationEvent"> = prisma): Promise<OperationalIncident | null> {
  const active = await db.operationalIncident.findFirst({
    where: {
      source: input.source,
      kind: input.kind,
      appId: input.appId ?? null,
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
    },
    orderBy: { firstDetectedAt: "desc" },
  });
  if (!active) return null;
  const incident = await db.operationalIncident.update({
    where: { id: active.id },
    data: {
      status: "RECOVERED",
      recoveredAt: input.recoveredAt,
      lastDetectedAt: input.recoveredAt,
    },
  });
  await enqueueIncident(incident, input.signalId, db);
  return incident;
}

export async function acknowledgeIncident(
  id: string,
  actorDiscordUserId: string,
  assignSelf: boolean,
) {
  const incident = await prisma.operationalIncident.findUnique({
    where: { id },
  });
  if (!incident) throw new Error("장애를 찾을 수 없습니다.");
  if (incident.status === "RECOVERED") return incident;
  await prisma.operationalIncident.updateMany({
    where: { id, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    data: {
      status: "ACKNOWLEDGED",
      acknowledgedBy: incident.acknowledgedBy ?? actorDiscordUserId,
      acknowledgedAt: incident.acknowledgedAt ?? new Date(),
      ...(assignSelf ? { assignedDiscordUserId: actorDiscordUserId } : {}),
    },
  });
  return prisma.operationalIncident.findUniqueOrThrow({ where: { id } });
}

/** 다른 주문의 성공을 복구로 추정하지 않고 권한 있는 운영자가 해결을 기록한다. */
export async function resolveIncident(
  id: string,
  actorDiscordUserId: string,
  expectedLastDetectedAt?: Date,
) {
  return prisma.$transaction(async (tx) => {
    const incident = await tx.operationalIncident.findUniqueOrThrow({
      where: { id },
    });
    if (incident.status === "RECOVERED") return incident;
    const evidence =
      incident.evidence &&
      typeof incident.evidence === "object" &&
      !Array.isArray(incident.evidence)
        ? incident.evidence
        : {};
    const changed = await tx.operationalIncident.updateMany({
      where: {
        id,
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        lastDetectedAt: expectedLastDetectedAt ?? incident.lastDetectedAt,
      },
      data: {
        status: "RECOVERED",
        recoveredAt: new Date(),
        evidence: {
          ...evidence,
          resolutionSource: "operator",
          resolvedBy: actorDiscordUserId,
        },
      },
    });
    if (!changed.count)
      throw Error(
        "장애에 새 관측이 추가됐습니다. 최신 내용을 확인한 뒤 다시 해결 처리하세요.",
      );
    const updated = await tx.operationalIncident.findUniqueOrThrow({
      where: { id },
    });
    await tx.auditLog.create({
      data: {
        actorLogin: `discord:${actorDiscordUserId}`,
        action: "incident.resolved",
        entityType: "operational_incident",
        entityId: id,
        payload: { source: "operator" },
      },
    });
    return updated;
  });
}
