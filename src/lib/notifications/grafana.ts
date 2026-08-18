import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { recordIncident, recoverIncident } from "@/lib/notifications/incidents";

const stringMap = z.record(z.string()).default({});
const alertSchema = z.object({
  status: z.enum(["firing", "resolved"]),
  labels: stringMap,
  annotations: stringMap,
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  fingerprint: z.string().min(1).max(160),
}).passthrough();

const webhookSchema = z.object({
  receiver: z.string().max(160),
  status: z.enum(["firing", "resolved"]),
  alerts: z.array(alertSchema).max(100),
}).passthrough();

export function parseGrafanaWebhook(value: unknown) {
  return webhookSchema.parse(value);
}

export async function ingestGrafanaWebhook(value: unknown): Promise<{ processed: number }> {
  const payload = parseGrafanaWebhook(value);
  for (const alert of payload.alerts) {
    const slug = alert.labels.app ?? alert.labels.app_slug ?? "";
    const app = slug
      ? await prisma.app.findUnique({ where: { slug }, select: { id: true, displayName: true } })
      : null;
    const alertName = alert.labels.alertname ?? "Grafana alert";
    const kind = `${alertName}:${alert.fingerprint}`.slice(0, 240);
    if (alert.status === "firing") {
      const detectedAt = new Date(alert.startsAt);
      await recordIncident({
        source: "grafana",
        kind,
        severity: alert.labels.severity === "critical" ? "critical" : "warning",
        summary: (alert.annotations.summary || alert.annotations.description || alertName).slice(0, 500),
        signalId: `${alert.fingerprint}:${detectedAt.getTime()}`,
        detectedAt,
        appId: app?.id,
        evidence: {
          alertName,
          team: alert.labels.team ?? "",
          receiver: payload.receiver,
          ...(slug ? { appSlug: slug } : {}),
        },
      });
    } else {
      await recoverIncident({
        source: "grafana",
        kind,
        appId: app?.id,
        signalId: `${alert.fingerprint}:resolved:${alert.endsAt ?? Date.now()}`,
        recoveredAt: alert.endsAt ? new Date(alert.endsAt) : new Date(),
      });
    }
  }
  return { processed: payload.alerts.length };
}
