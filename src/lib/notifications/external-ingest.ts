import {
  notificationChannelId,
  notificationDestinations,
  type DestinationKey,
  type NotificationDestination,
} from "@/lib/notifications/destinations";
import {
  parseExternalNotification,
  routeFromNotificationSubject,
  type NotificationAck,
} from "@/lib/notifications/external-contract";
import { enqueueNotification } from "@/lib/notifications/outbox";

interface ExternalIngestDependencies {
  destinationConfigured?: (route: DestinationKey) => boolean;
  destinations?: (route: DestinationKey) => NotificationDestination[];
  enqueue?: typeof enqueueNotification;
}

export async function ingestExternalNotification(
  subject: string,
  value: unknown,
  dependencies: ExternalIngestDependencies = {},
): Promise<NotificationAck> {
  const route = routeFromNotificationSubject(subject);
  if (!route) throw new Error("허용되지 않은 NATS subject");
  const destinationConfigured =
    dependencies.destinationConfigured ??
    ((key: DestinationKey) => /^\d+$/.test(notificationChannelId(key)));
  if (!destinationConfigured(route))
    throw new Error(`Slack 목적지 미설정: ${route}`);
  const destinations = (
    dependencies.destinations ?? ((key) => notificationDestinations([key]))
  )(route);
  if (destinations.length !== 1)
    throw new Error(`Slack 목적지 미설정: ${route}`);
  const payload = parseExternalNotification(value);
  const eventId = await (dependencies.enqueue ?? enqueueNotification)({
    dedupeKey: `external:${payload.source}:${payload.id}`,
    kind: "EXTERNAL_FEED",
    occurredAt: payload.occurredAt ? new Date(payload.occurredAt) : undefined,
    payload: {
      text: payload.report
        ? [
            `**${payload.report.subject} · ${payload.report.conclusion}**`,
            ...payload.report.evidence.map((line) => `- ${line}`),
            payload.report.meaning,
            payload.report.action,
          ]
            .filter(Boolean)
            .join("\n")
        : payload.text,
      ...(payload.report
        ? {
            report: {
              category: payload.report.category,
              reason: "EXTERNAL_EVIDENCE",
              topicKey: payload.report.topicKey,
            },
          }
        : {}),
      source: payload.source,
      externalId: payload.id,
      ...(payload.attachment ? { attachment: payload.attachment } : {}),
      ...(payload.thread
        ? {
            thread: {
              parentDedupeKey: `external:${payload.source}:${payload.thread.parentId}`,
              threadName: payload.thread.name,
              plain: payload.thread.plain ?? false,
            },
          }
        : {}),
    },
    destinations,
  });
  return { accepted: true, id: eventId };
}
