import { configuredDestinations, type NotificationDestination } from "@/lib/notifications/destinations";
import {
  parseExternalNotification,
  routeFromNotificationSubject,
  type NotificationAck,
} from "@/lib/notifications/external-contract";
import { enqueueNotification } from "@/lib/notifications/outbox";

interface ExternalIngestDependencies {
  destinations?: (route: Parameters<typeof configuredDestinations>[0][number]) => NotificationDestination[];
  enqueue?: typeof enqueueNotification;
}

export async function ingestExternalNotification(
  subject: string,
  value: unknown,
  dependencies: ExternalIngestDependencies = {},
): Promise<NotificationAck> {
  const route = routeFromNotificationSubject(subject);
  if (!route) throw new Error("허용되지 않은 NATS subject");
  const destinations = (dependencies.destinations ?? ((key) => configuredDestinations([key])))(route);
  if (destinations.length !== 1) throw new Error(`Discord 목적지 미설정: ${route}`);
  const payload = parseExternalNotification(value);
  const eventId = await (dependencies.enqueue ?? enqueueNotification)({
    dedupeKey: `external:${payload.source}:${payload.id}`,
    kind: "EXTERNAL_FEED",
    occurredAt: payload.occurredAt ? new Date(payload.occurredAt) : undefined,
    payload: {
      text: payload.text,
      source: payload.source,
      externalId: payload.id,
      ...(payload.attachment ? { attachment: payload.attachment } : {}),
    },
    destinations,
  });
  return { accepted: true, id: eventId };
}
